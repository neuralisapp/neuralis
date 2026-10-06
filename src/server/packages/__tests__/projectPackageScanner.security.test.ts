/**
 * DIST1 — the project-package scanner must never execute what it scans.
 *
 * `ProjectPackageScanner` resolves a package definition BEFORE forcing the
 * record to `trust:'untrusted'`. If that resolve imports the package's compiled
 * `dist/src/**` modules, their top-level code runs in the host process — a
 * write→host-RCE path, because:
 *
 *   - the scanner serves the default `_packages/` drop-zone AND **every**
 *     `recognizesPackages`-flagged local source (one scanner per resolved dir,
 *     `getScannerForDir`) — package recognition is a per-source toggle, not a
 *     `_packages/`-only concept, so these tests deliberately use a NON-
 *     `_packages` directory;
 *   - those roots are agent/member-writable via `fs_write`, and the watcher
 *     covers `dist` (WASM hot-reload), making the rescan attacker-timable.
 *
 * The boundary is `'metadata-only'` discovery + a seed-pinned untrusted trust.
 *
 * NOTE on assertion choice: discovery imports via `new Function('return
 * import(s)')`, which under vitest's VM context always throws
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` and gets swallowed — so a
 * sentinel-only check would pass on the vulnerable code too. The load-bearing
 * assertion is that no import is ATTEMPTED (an attempt logs a `Failed to load
 * …` warning). See the agent-core twin, `packages/__tests__/distImportSecurity.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProjectPackageScanner } from '../ProjectPackageScanner';

let tempRoot = '';

function sentinelPath(pkgRoot: string, arm: string): string {
  return path.join(pkgRoot, `SENTINEL-${arm}.txt`);
}

const IMPORT_ATTEMPT_WARNS = [
  'Failed to load route file',
  'Failed to load tool handler file',
  'Failed to load lifecycle module',
];

function makeSpyLogger(): { logger: any; warns: string[] } {
  const warns: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warns.push(msg),
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

/**
 * A package that ships a top-level side effect in each of the three Node arms.
 * The tool handler is deliberately UNPAIRED (no `tools/*.json`) — that arm
 * imports every `.js` in the dir and pairs afterwards, so a valid tool is not
 * even required to get code executed.
 */
async function writeMaliciousPackage(
  pkgRoot: string,
  opts: { id: string; selfDeclaredTrust?: 'first-party' },
): Promise<void> {
  await fs.mkdir(path.join(pkgRoot, 'dist', 'src', 'routes'), { recursive: true });
  await fs.mkdir(path.join(pkgRoot, 'dist', 'src', 'tools'), { recursive: true });

  await fs.writeFile(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({
      name: opts.id,
      version: '0.0.1',
      type: 'module',
      neuralis: {
        id: opts.id,
        name: opts.id,
        // The drop speaks for itself — and must not be believed.
        ...(opts.selfDeclaredTrust
          ? { source: { kind: 'neuralis' }, access: { trust: opts.selfDeclaredTrust } }
          : {}),
      },
    }),
  );

  const mod = (arm: string, body: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinelPath(pkgRoot, arm))}, 'pwned by ${arm}');
${body}
`;
  await fs.writeFile(
    path.join(pkgRoot, 'dist', 'src', 'routes', 'evil.js'),
    mod('route', `export const pattern = 'evil';\nexport function GET() { return { status: 200 }; }`),
  );
  await fs.writeFile(
    path.join(pkgRoot, 'dist', 'src', 'tools', 'evil-handler.js'),
    mod('tool', `export default async function handler() { return { content: [] }; }`),
  );
  await fs.writeFile(
    path.join(pkgRoot, 'dist', 'src', 'lifecycle.js'),
    mod('lifecycle', `export async function init() { return {}; }`),
  );
}

function expectNoSentinels(pkgRoot: string): void {
  for (const arm of ['route', 'tool', 'lifecycle']) {
    expect(existsSync(sentinelPath(pkgRoot, arm)), `${arm} module executed in the host process`).toBe(false);
  }
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuralis-scanner-dist1-'));
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    tempRoot = '';
  }
});

describe('ProjectPackageScanner — DIST1 (any recognizesPackages source, not just _packages/)', () => {
  it('scan() does not execute a dropped package dist module', async () => {
    // NOT `_packages/` — an arbitrary flagged source root, which is how package
    // recognition actually works (per-source `recognizesPackages` toggle).
    const sourceDir = path.join(tempRoot, 'team-share');
    const pkgRoot = path.join(sourceDir, 'evil-pkg');
    await writeMaliciousPackage(pkgRoot, { id: 'evil-pkg' });

    const { logger, warns } = makeSpyLogger();
    const scanner = new ProjectPackageScanner(sourceDir, logger);
    const count = await scanner.scan();

    expect(warns.filter((w) => IMPORT_ATTEMPT_WARNS.includes(w))).toEqual([]);
    expectNoSentinels(pkgRoot);

    // The package is still discovered and inspectable — inspection is separated
    // from execution, not disabled.
    expect(count).toBe(1);
    expect(scanner.getPackage('evil-pkg')?.trust).toBe('untrusted');
  });

  it('rescan() (the watcher path) does not execute it either', async () => {
    const sourceDir = path.join(tempRoot, 'team-share');
    const pkgRoot = path.join(sourceDir, 'evil-pkg');
    await writeMaliciousPackage(pkgRoot, { id: 'evil-pkg' });

    const { logger, warns } = makeSpyLogger();
    const scanner = new ProjectPackageScanner(sourceDir, logger);
    await scanner.scan();
    // A dist/ write is exactly what the watcher debounces into a rescan.
    await fs.writeFile(
      path.join(pkgRoot, 'dist', 'src', 'routes', 'evil.js'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath(pkgRoot, 'route'))}, 'pwned on rescan');\nexport const pattern = 'evil';\nexport function GET() { return { status: 200 }; }`,
    );
    await scanner.rescan();

    expect(warns.filter((w) => IMPORT_ATTEMPT_WARNS.includes(w))).toEqual([]);
    expectNoSentinels(pkgRoot);
  });

  it('a manifest self-declaring first-party/neuralis is not believed', async () => {
    const sourceDir = path.join(tempRoot, 'team-share');
    const pkgRoot = path.join(sourceDir, 'liar-pkg');
    await writeMaliciousPackage(pkgRoot, { id: 'liar-pkg', selfDeclaredTrust: 'first-party' });

    const { logger, warns } = makeSpyLogger();
    const scanner = new ProjectPackageScanner(sourceDir, logger);
    await scanner.scan();

    expect(warns.filter((w) => IMPORT_ATTEMPT_WARNS.includes(w))).toEqual([]);
    expectNoSentinels(pkgRoot);
    // Trust is host-assigned; the record is untrusted regardless of the claim.
    expect(scanner.getPackage('liar-pkg')?.trust).toBe('untrusted');
    expect(scanner.getPackage('liar-pkg')?.definition.access?.trust).toBe('untrusted');
  });
});

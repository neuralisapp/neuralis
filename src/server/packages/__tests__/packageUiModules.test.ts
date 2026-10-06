/**
 * `buildUiAttachments` — the module table, the version pins and the union sheet.
 *
 * Every refusal row has its accepted twin: the same fixture with ONE field
 * changed loads. The union-sheet rows use the host's REAL Tailwind engine over
 * real tmp trees (no stub), so a stable hash and order independence are
 * measured, not asserted about a fake.
 */

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { compileUnionSheet, type TailwindEngine } from '@neuralis/package-system/runtime/ui-sheet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UI_MODULE_HOST_API_VERSION, resolveBundleReactMajor } from '@neuralis/package-system/client/shared-modules';
import {
  PACKAGE_UI_ROUTE_PREFIX,
  buildUiAttachments,
  hostSheetSources,
  viewUiAttachments,
  type UiAttachmentDeps,
  type UiAttachments,
} from '../packageUiModules';
import { UI_MODULE_URL_PREFIX } from '../../../workspace/packages/uiModuleLoader';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');

/** The host's own engine — directly once the host declares it, else through the postcss plugin's install. */
function loadHostEngine(): TailwindEngine {
  const hostReq = createRequire(join(HOST_ROOT, 'package.json'));
  const tw = hostReq('tailwindcss') as { compile: TailwindEngine['compile'] };
  let oxide: { Scanner: TailwindEngine['Scanner'] };
  try {
    oxide = hostReq('@tailwindcss/oxide') as typeof oxide;
  } catch {
    const viaPostcss = realpathSync(join(HOST_ROOT, 'node_modules/@tailwindcss/postcss/package.json'));
    oxide = createRequire(viaPostcss)('@tailwindcss/oxide') as typeof oxide;
  }
  return { compile: tw.compile, Scanner: oxide.Scanner, stylesheetRoot: dirname(hostReq.resolve('tailwindcss/package.json')) };
}

let root: string;

function definition(id: string, module?: { entry: string; css?: string; provides?: string[] }): PackageDefinition {
  return {
    id,
    name: id,
    version: '1.0.0',
    access: { trust: 'first-party' },
    ...(module ? { app: { module } } : {}),
  } as unknown as PackageDefinition;
}

/** A built module; the record (`shared-imports.json`) is the builder's: React 19, reads `react`. */
async function writePackage(
  dir: string,
  opts: { record?: unknown; entry?: string; css?: string; appSource?: string },
): Promise<void> {
  await mkdir(join(dir, 'dist', 'app'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  await writeFile(join(dir, 'dist', 'app', opts.entry ?? 'host.js'), 'export function installXHostComponents() {}\n');
  if (opts.css) await writeFile(join(dir, 'dist', 'app', opts.css), '.x{color:red}');
  await writeFile(
    join(dir, 'dist', 'app', 'shared-imports.json'),
    JSON.stringify(opts.record ?? { version: UI_MODULE_HOST_API_VERSION, reactMajor: 19, imports: ['react'] }),
  );
  if (opts.appSource) {
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'ui.tsx'), opts.appSource);
  }
}

function deps(over: Partial<UiAttachmentDeps> & Pick<UiAttachmentDeps, 'definitions' | 'resolveRoot'>): UiAttachmentDeps {
  return { hostReactMajor: 19, compileSheet: async () => null, hostSources: [], ...over };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neuralis-ui-attach-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveBundleReactMajor (fail-closed pin, from the build record)', () => {
  it('accepts the major the bundle was built against only when it is the host major', () => {
    expect(resolveBundleReactMajor({ reactMajor: 19, imports: ['react'] }, 19)).toBe(19);
    expect(resolveBundleReactMajor({ reactMajor: 18, imports: ['react'] }, 19)).toBeNull();
    expect(resolveBundleReactMajor({ reactMajor: 20, imports: ['react/jsx-runtime'] }, 19)).toBeNull();
  });

  it('refuses a bundle that reads React with no recorded major; one that reads none has nothing to pin', () => {
    expect(resolveBundleReactMajor({ imports: ['react-dom/client'] }, 19)).toBeNull();
    expect(resolveBundleReactMajor({ imports: ['@neuralis/package-system/client'] }, 19)).toBe(19);
    expect(resolveBundleReactMajor({ imports: [] }, 19)).toBe(19);
  });
});

describe('viewUiAttachments — the caller sees its visible packages\' modules AND refusals', () => {
  it('a refusal travels to the client only for a package the caller can see', () => {
    const built = {
      modules: [],
      sheet: null,
      refused: [{ packageId: '@acme/visible', reason: 'react-major' }, { packageId: '@acme/hidden', reason: 'not-built' }],
      table: new Map(),
      buildMs: 0,
    } as UiAttachments;
    expect(viewUiAttachments(built, new Set(['@acme/visible'])).refused).toEqual([{ packageId: '@acme/visible', reason: 'react-major' }]);
    expect(viewUiAttachments(built, new Set()).refused).toEqual([]);
  });
});

describe('buildUiAttachments — module table', () => {
  it('derives a stable content-hash URL for a well-formed module (the accepted twin)', async () => {
    const dir = join(root, 'ok');
    await writePackage(dir, { css: 'host.css' });
    const def = definition('@acme/ok', { entry: 'dist/app/host.js', css: 'dist/app/host.css' });
    const a = await buildUiAttachments(deps({ definitions: [def], resolveRoot: () => dir }));
    const b = await buildUiAttachments(deps({ definitions: [def], resolveRoot: () => dir }));
    expect(a.refused).toEqual([]);
    expect(a.modules).toHaveLength(1);
    const [m] = a.modules;
    expect(m.hash).toBe(b.modules[0].hash);
    expect(m.entryUrl).toBe(`/api/package-ui/${m.hash}/host.js`);
    expect(m.cssUrl).toBe(`/api/package-ui/${m.hash}/host.css`);
    expect(m.reactMajor).toBe(19);
    expect(m.hostApiVersion).toBe(UI_MODULE_HOST_API_VERSION);
    expect(a.table.get(m.hash)).toEqual({ kind: 'module', packageId: '@acme/ok', dir: join(dir, 'dist', 'app') });
  });

  it('moves the hash when a served byte changes', async () => {
    const dir = join(root, 'moves');
    await writePackage(dir, {});
    const def = definition('@acme/moves', { entry: 'dist/app/host.js' });
    const before = (await buildUiAttachments(deps({ definitions: [def], resolveRoot: () => dir }))).modules[0].hash;
    await writeFile(join(dir, 'dist', 'app', 'host.js'), 'export function installXHostComponents() { return 2; }\n');
    const after = (await buildUiAttachments(deps({ definitions: [def], resolveRoot: () => dir }))).modules[0].hash;
    expect(after).not.toBe(before);
  });

  it('refuses a bundle built for another React major, and one reading React with no recorded major', async () => {
    const old = join(root, 'react18');
    const none = join(root, 'noreact');
    await writePackage(old, { record: { version: UI_MODULE_HOST_API_VERSION, reactMajor: 18, imports: ['react'] } });
    await writePackage(none, { record: { version: UI_MODULE_HOST_API_VERSION, imports: ['react'] } });
    const built = await buildUiAttachments(deps({
      definitions: [definition('@acme/old', { entry: 'dist/app/host.js' }), definition('@acme/none', { entry: 'dist/app/host.js' })],
      resolveRoot: (id) => (id === '@acme/old' ? old : none),
    }));
    expect(built.modules).toEqual([]);
    expect(built.refused).toEqual([
      { packageId: '@acme/none', reason: 'react-major' },
      { packageId: '@acme/old', reason: 'react-major' },
    ]);
  });

  it('refuses a bundle built for another host API version', async () => {
    const dir = join(root, 'api2');
    await writePackage(dir, { record: { version: UI_MODULE_HOST_API_VERSION + 1, reactMajor: 19, imports: [] } });
    const built = await buildUiAttachments(deps({ definitions: [definition('@acme/api2', { entry: 'dist/app/host.js' })], resolveRoot: () => dir }));
    expect(built.refused).toEqual([{ packageId: '@acme/api2', reason: 'host-api-version' }]);
  });

  it('refuses an entry outside dist/app and an unbuilt package', async () => {
    const dir = join(root, 'outside');
    await writePackage(dir, {});
    const built = await buildUiAttachments(deps({
      definitions: [
        definition('@acme/a', { entry: 'dist/app/../../package.json' }),
        definition('@acme/b', { entry: 'src/host.js' }),
        definition('@acme/c', { entry: 'dist/app/host.js' }),
      ],
      resolveRoot: (id) => (id === '@acme/c' ? join(root, 'never-built') : dir),
    }));
    expect(built.modules).toEqual([]);
    expect(built.refused.map((r) => r.reason)).toEqual(['entry-outside-module-dir', 'entry-outside-module-dir', 'not-built']);
  });

  it('names a record that exists but cannot be read apart from a missing one (one vocabulary with the image build)', async () => {
    const dir = join(root, 'record-is-a-dir');
    await mkdir(join(dir, 'dist', 'app', 'shared-imports.json'), { recursive: true });
    const built = await buildUiAttachments(deps({ definitions: [definition('@acme/d', { entry: 'dist/app/host.js' })], resolveRoot: () => dir }));
    expect(built.refused).toEqual([{ packageId: '@acme/d', reason: 'shared-imports-unreadable' }]);
  });

  it("carries the package's declared tier-2 ids, and none when it declares none (paired)", async () => {
    const dir = join(root, 'provides');
    await writePackage(dir, {});
    const provides = ['@acme/p/app/store'];
    const built = await buildUiAttachments(deps({
      definitions: [
        definition('@acme/p', { entry: 'dist/app/host.js', provides }),
        definition('@acme/q', { entry: 'dist/app/host.js' }),
      ],
      resolveRoot: () => dir,
    }));
    expect(built.modules.find((m) => m.packageId === '@acme/p')?.provides).toEqual(provides);
    expect(built.modules.find((m) => m.packageId === '@acme/q')).not.toHaveProperty('provides');
  });

  it("the loader's URL prefix is the server's (the client twin cannot import a server module)", () => {
    expect(UI_MODULE_URL_PREFIX).toBe(PACKAGE_UI_ROUTE_PREFIX);
  });
});

describe('buildUiAttachments — union sheet', () => {
  it('compiles ONE sheet over every first-party package, with a hash independent of package order', async () => {
    const a = join(root, 'sheetA');
    const c = join(root, 'sheetC');
    await writePackage(a, { appSource: 'export const A = () => <div className="p-2 md:p-4" />;' });
    await writePackage(c, { appSource: 'export const C = () => <div className="!p-1 p-2" />;' });
    const engine = loadHostEngine();
    const defs = [definition('@acme/a', { entry: 'dist/app/host.js' }), definition('@acme/c')];
    const resolveRoot = (id: string): string => (id === '@acme/a' ? a : c);
    const forward = await buildUiAttachments(deps({ definitions: defs, resolveRoot, compileSheet: (sources) => compileUnionSheet({ engine, sources }) }));
    const reverse = await buildUiAttachments(deps({ definitions: [...defs].reverse(), resolveRoot, compileSheet: (sources) => compileUnionSheet({ engine, sources }) }));
    expect(forward.sheetError).toBeUndefined();
    expect(forward.sheet).not.toBeNull();
    expect(forward.sheet?.hash).toBe(reverse.sheet?.hash);
    expect(forward.sheet?.url).toBe(`/api/package-ui/${forward.sheet?.hash}/workspace.css`);
    const entry = forward.table.get(forward.sheet?.hash ?? '');
    expect(entry?.kind).toBe('sheet');
    const css = entry?.kind === 'sheet' ? entry.css.toString('utf8') : '';
    // ONE sheet, Tailwind's own order: the bare utility BEFORE its responsive override.
    expect(css.indexOf('.p-2 {')).toBeGreaterThan(-1);
    expect(css.indexOf('.p-2 {')).toBeLessThan(css.lastIndexOf('md\\:p-4'));
    expect(css).toContain('\\!p-1');
  });

  it("scans the host's own src/ when it exists, else the built client chunks", () => {
    expect(hostSheetSources(HOST_ROOT, '/nowhere')[0]).toEqual({ base: join(HOST_ROOT, 'src'), pattern: '**/*.{ts,tsx}' });
    expect(hostSheetSources('/nowhere', '/nowhere')).toEqual([]);
  });

  it('in the image shape scans the built chunks even when a (tracer-subset) src/ exists', async () => {
    const image = join(root, 'image-shape');
    const runtime = join(image, '_runtime');
    await mkdir(join(image, 'src', 'workspace'), { recursive: true });
    await mkdir(join(runtime, '.next', 'static', 'chunks'), { recursive: true });
    expect(hostSheetSources(image, runtime)).toEqual([
      { base: join(runtime, '.next', 'static', 'chunks'), pattern: '**/*.js' },
    ]);
    // Paired: the same tree run from a non-runtime cwd is a dev tree and scans src/.
    expect(hostSheetSources(image, image)[0]).toEqual({ base: join(image, 'src'), pattern: '**/*.{ts,tsx}' });
  });

  it('keeps the modules when the sheet cannot compile, and names why', async () => {
    const dir = join(root, 'sheetfail');
    await writePackage(dir, {});
    const broken: TailwindEngine = {
      compile: async () => {
        throw new Error('boom');
      },
      Scanner: class {
        files: string[] = [];
        scan(): string[] {
          return [];
        }
      } as unknown as TailwindEngine['Scanner'],
      stylesheetRoot: '/nowhere',
    };
    const built = await buildUiAttachments(deps({
      definitions: [definition('@acme/sf', { entry: 'dist/app/host.js' })],
      resolveRoot: () => dir,
      compileSheet: (sources) => compileUnionSheet({ engine: broken, sources }),
    }));
    expect(built.modules).toHaveLength(1);
    expect(built.sheet).toBeNull();
    expect(built.sheetError).toBe('UnionSheetCompileFailed');
  });
});

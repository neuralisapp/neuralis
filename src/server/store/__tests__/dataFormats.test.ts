/**
 * The host's data-format claim (`dataFormats.ts`) against the REAL kernel ledger
 * in a temp home.
 *
 * What is pinned: the claim is ORDER-FREE (a store that reaches disk before the
 * bootstrap runs the claim itself; the bootstrap's later claim picks up what the
 * packages declared), a kind nobody DECLARED is a failure and never a warning,
 * and newer data stops everything with the kind, both versions, the newest
 * checkpoint and the exact restore command — writing nothing.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nrs-data-formats-'));
const appRoot = join(home, 'app');

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(home, 'projects') }),
}));

const { resetDataFormatsForTesting, declareDataFormats, createCheckpoint, DATA_FORMAT_LEDGER_RELATIVE_PATH } =
  await import('@neuralis/package-system/data');
const {
  HOST_DATA_FORMATS,
  claimAllDeclaredDataFormats,
  claimHostDataFormats,
  ensureHostDataFormat,
  resetHostDataFormatClaimForTesting,
} = await import('../dataFormats');
const { getPlatformConfigStore, resetPlatformConfigStore } = await import('../PlatformConfigStore');
const { HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS } = await import('../../config/hostConfigSettings');

const ledgerPath = join(appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH);
const readLedger = (): Record<string, { version: number }> =>
  JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Record<string, { version: number }>;

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(appRoot, 'config'), { recursive: true });
  resetDataFormatsForTesting();
  resetHostDataFormatClaimForTesting();
  // A reset registry is empty: re-declare what the module declared at load.
  declareDataFormats(Object.values(HOST_DATA_FORMATS));
  resetPlatformConfigStore();
  getPlatformConfigStore(appRoot).registerSettings(HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the claim is order-free', () => {
  it('a store reaching disk BEFORE the bootstrap runs the claim itself; the later bootstrap claim adds package kinds', async () => {
    await ensureHostDataFormat(HOST_DATA_FORMATS.user);
    expect(Object.keys(readLedger()).sort()).toEqual(Object.values(HOST_DATA_FORMATS).map((f) => f.kind).sort());

    declareDataFormats([{ kind: 'some-pkg/record', version: 2, files: [] }]);
    await claimAllDeclaredDataFormats();
    expect(readLedger()['some-pkg/record']?.version).toBe(2);
  });

  it('the reverse order lands the same ledger', async () => {
    declareDataFormats([{ kind: 'some-pkg/record', version: 2, files: [] }]);
    await claimAllDeclaredDataFormats();
    await ensureHostDataFormat(HOST_DATA_FORMATS.project);
    expect(Object.keys(readLedger()).sort()).toEqual(
      [...Object.values(HOST_DATA_FORMATS).map((f) => f.kind), 'some-pkg/record'].sort(),
    );
  });
});

describe('a kind nobody declared is a FAILURE, never a warning', () => {
  it('a store asking for an undeclared kind is refused', async () => {
    await expect(ensureHostDataFormat({ kind: 'neuralis/ghost', version: 1, files: [] } as never)).rejects.toMatchObject({
      code: 'data_format_claim',
      reason: 'undeclared',
    });
  });

  it('a store claiming a version its declaration does not carry is refused', async () => {
    await expect(ensureHostDataFormat({ ...HOST_DATA_FORMATS.user, version: 2 } as never)).rejects.toMatchObject({
      reason: 'version_mismatch',
    });
  });

  it('PAIRED CONTROL — the declared kind at its declared version resolves', async () => {
    await expect(ensureHostDataFormat(HOST_DATA_FORMATS.user)).resolves.toBeUndefined();
  });
});

describe('newer data stops the boot and names the way back', () => {
  it('kind + both versions + the newest checkpoint + the exact restore command; nothing is written', async () => {
    writeFileSync(join(appRoot, 'config', 'platform.json'), '{}');
    const cp = await createCheckpoint(home, { label: 'before-upgrade', files: ['app/config/platform.json'] });
    writeFileSync(ledgerPath, JSON.stringify({ 'neuralis/project': { version: 7, raisedAt: 'x' } }));
    const before = readFileSync(ledgerPath, 'utf-8');

    const refusal = claimHostDataFormats();
    await expect(refusal).rejects.toThrow(/neuralis\/project v7 \(this build reads v1\)/);
    await expect(refusal).rejects.toThrow(new RegExp(`Newest checkpoint: ${cp.id}`));
    await expect(refusal).rejects.toThrow(`pnpm neuralis:checkpoint restore ${cp.id}`);
    await expect(refusal).rejects.toThrow('docker compose run --rm --no-deps neuralis node --import tsx scripts/checkpoint.mts restore');
    expect(readFileSync(ledgerPath, 'utf-8')).toBe(before);

    // A failed claim is not memoized: once the data is put back, the next boot claims.
    writeFileSync(ledgerPath, '{}');
    await expect(claimHostDataFormats()).resolves.toMatchObject({ written: expect.arrayContaining(['neuralis/project']) });
  });

  it('an older stored format is raised only after a checkpoint of that kind (dir 0700), never of a secret it does not own', async () => {
    mkdirSync(join(appRoot, 'users'), { recursive: true });
    writeFileSync(join(appRoot, 'users', 'u1.json'), '{"id":"u1"}', { mode: 0o600 });
    mkdirSync(join(appRoot, 'credentials', 'global'), { recursive: true });
    writeFileSync(join(appRoot, 'credentials', 'global', 'llm.x.enc.json'), '{}');
    // Only a raise takes a checkpoint; a ledger at v0 makes `neuralis/user` older than this build.
    writeFileSync(ledgerPath, JSON.stringify({ 'neuralis/user': { version: 0, raisedAt: 'x' } }));

    const report = await claimHostDataFormats();
    expect(report.raised).toEqual([{ kind: 'neuralis/user', from: 0, to: 1 }]);
    const dir = join(home, 'checkpoints', report.checkpoint!);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, 'app', 'users', 'u1.json'), 'utf-8')).toBe('{"id":"u1"}');
    expect(existsSync(join(dir, 'app', 'credentials'))).toBe(false);
    expect(readLedger()['neuralis/user']?.version).toBe(1);
  });
});

describe('the bootstrap wiring', () => {
  // Order is the whole property and no unit test reaches `getRuntime()`, so
  // the source is the instrument (line comments stripped; a block-comment
  // strip would eat code after a `'/*'` inside a string).
  const source = readFileSync(join(__dirname, '..', '..', 'host', 'bootstrap.ts'), 'utf-8').replace(
    /^\s*\/\/.*$/gm,
    '',
  );

  it('claims every declared kind BEFORE the first store read, and again AFTER the loader evaluated the packages', () => {
    const firstRead = source.indexOf('await hasAnyUsers()');
    const packagesInit = source.indexOf('await runtimeProvider.boot(');
    const packagesReady = source.indexOf('await instance.whenReady()');
    const early = source.indexOf('await claimAllDeclaredDataFormats()');
    const late = source.indexOf('await claimAllDeclaredDataFormats()', early + 1);
    expect(packagesInit).toBeGreaterThan(-1);
    expect(packagesReady).toBeGreaterThan(packagesInit);
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(firstRead);
    expect(late).toBeGreaterThan(packagesReady);
  });
});

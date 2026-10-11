import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetVectorCollectionState } from '@neuralis/brain-core';
import { resetVectorStore } from '../reset-vector.mts';
import type { OfflineProbes } from '../checkpoint.mts';

const homes: string[] = [];
afterEach(async () => { forgetVectorCollectionState(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'reset-vector-'));
  homes.push(home);
  const path = join(home, 'app', 'config', 'embedding-lock.json');
  await mkdir(join(home, 'app', 'config'), { recursive: true });
  const bytes = JSON.stringify({ version: 3, mode: 'metadata', collection: 'recorded-serving', createdAt: 'now',
    rebuild: { phase: 'prepared', shadowCollection: 'recorded-shadow' } });
  await writeFile(path, bytes);
  const probes: OfflineProbes = { inContainer: false, http: async () => ({ kind: 'absent' }),
    composeRunning: async () => ({ kind: 'no-docker' }) };
  const list = vi.fn(async () => ['foreign', 'base__garbage', 'recorded-serving', 'recorded-shadow', 'base__g1', 'base__shadow_11111111-1111-1111-1111-111111111111', 'base']);
  const drop = vi.fn(async (_url: string, _name: string) => {});
  const opts = { home, qdrantUrl: 'http://qdrant.invalid', prefix: 'unused', explicit: 'base', appPort: 9999, neuralisDir: home };
  return { path, bytes, probes, list, drop, opts };
}

describe('offline vector reset', () => {
  it.each(['http', 'compose'] as const)('refuses when %s cannot prove quiescence, before collection access', async plane => {
    const f = await fixture();
    if (plane === 'http') f.probes.http = async () => ({ kind: 'unknown', detail: 'timeout' });
    else f.probes.composeRunning = async () => ({ kind: 'failed', detail: 'daemon unavailable' });
    await expect(resetVectorStore(f.opts, f.probes, f)).rejects.toThrow();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.drop).not.toHaveBeenCalled();
    expect(await readFile(f.path, 'utf8')).toBe(f.bytes);
  });

  // Target selection and partial-failure retention are `resetOwnedCollections`' own
  // table (brain-core `vectorMaintenance.test.ts`); this row pins the script's
  // wiring: the lock is read from `<home>/app` and the cleanup unlinks that file.
  it('reads the lock under the home and unlinks it after the drops', async () => {
    const f = await fixture();
    expect(await resetVectorStore(f.opts, f.probes, f)).toEqual(['recorded-serving', 'recorded-shadow', 'base__g1', 'base__shadow_11111111-1111-1111-1111-111111111111', 'base']);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([{ version: 4 }, { version: 3, mode: 'dense' }])('refuses malformed/newer lock before listing: %s', async raw => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify(raw));
    await expect(resetVectorStore(f.opts, f.probes, f)).rejects.toThrow();
    expect(f.list).not.toHaveBeenCalled();
    expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify(raw));
  });
});

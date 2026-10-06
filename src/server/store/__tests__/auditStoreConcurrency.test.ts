/**
 * The audit appender's write queue must be PROCESS-level, not module-level.
 *
 * Next bundles this module separately into ~25 route bundles, so a
 * module-scoped `new JsonlAppender()` yields one queue PER BUNDLE — and the
 * rename-only rotation is a stat-then-rename, so a rotation in one bundle's
 * queue could move the file under another bundle's write (the PlatformConfigStore
 * two-copy class). The test obtains a REAL second module copy with
 * `vi.resetModules()` and interleaves writes from both, across rotations: every
 * row must survive, in order, and no generation may be deleted.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = mkdtempSync(join(tmpdir(), 'audit-conc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ appRoot: tmp }),
}));

let maxBytes: unknown = 26_214_400;
vi.mock('../PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: () => maxBytes }),
}));

type Row = { target?: string; timestamp: string };

/** Every row on disk, oldest first: the highest generation down to the live file. */
function allRows(): Row[] {
  const dir = join(tmp, 'logs');
  const generations = readdirSync(dir)
    .map((name) => /^audit\.jsonl(?:\.(\d+))?$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], index: m[1] === undefined ? 0 : Number(m[1]) }))
    .sort((a, b) => b.index - a.index);
  return generations.flatMap(({ name }) =>
    readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row));
}

type AuditModule = typeof import('../AuditStore');

describe('audit appender — one queue per PROCESS', () => {
  it('two module copies writing concurrently lose no rows', async () => {
    const first: AuditModule = await import('../AuditStore');
    vi.resetModules();
    const second: AuditModule = await import('../AuditStore');
    expect(second).not.toBe(first);

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(first.writeAuditLog({ userId: 'u1', action: 'login.success', target: `a-${i}` }));
      writes.push(second.writeAuditLog({ userId: 'u1', action: 'login.success', target: `b-${i}` }));
    }
    await Promise.all(writes);

    const rows = allRows();
    expect(rows).toHaveLength(40);
    const targets = new Set(rows.map((r) => r.target));
    expect(targets.size).toBe(40);
  });

  it('rotation renames only — every generation survives, oldest first', async () => {
    const mod: AuditModule = await import('../AuditStore');
    maxBytes = 400; // a few rows per generation
    try {
      for (let i = 0; i < 30; i++) await mod.writeAuditLog({ userId: 'u2', action: 'login.success', target: `r-${i}` });
    } finally {
      maxBytes = 26_214_400;
    }
    const generations = readdirSync(join(tmp, 'logs')).filter((n) => /^audit\.jsonl\.\d+$/.test(n));
    expect(generations.length).toBeGreaterThan(2);
    const rotated = allRows().filter((r) => r.target?.startsWith('r-')).map((r) => r.target);
    expect(rotated).toEqual(Array.from({ length: 30 }, (_, i) => `r-${i}`));
  });
});

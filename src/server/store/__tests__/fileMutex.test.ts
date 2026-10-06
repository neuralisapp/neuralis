import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireFileMutex } from '../fileMutex';

describe('fileMutex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'neuralis-mutex-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('two sequential acquires for the same path serialize', async () => {
    const lock = join(tempDir, 'a.lock');
    const order: string[] = [];

    const release1 = await acquireFileMutex(lock);
    order.push('A acquired');

    const acquireB = (async () => {
      const release2 = await acquireFileMutex(lock, { pollIntervalMs: 10 });
      order.push('B acquired');
      await release2();
      order.push('B released');
    })();

    // Give B time to be stuck waiting on the lock.
    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual(['A acquired']);
    order.push('A releasing');
    await release1();
    await acquireB;
    expect(order).toEqual(['A acquired', 'A releasing', 'B acquired', 'B released']);
  });

  it('stale lock (old mtime stamp) is reclaimed', async () => {
    const lock = join(tempDir, 'stale.lock');
    // Plant a stale lock by hand.
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(`${lock}/mtime.txt`, `${Date.now() - 60_000}\n12345\n`, { mode: 0o600 });
    const release = await acquireFileMutex(lock, { staleAfterMs: 1_000, timeoutMs: 2_000 });
    await release();
    expect(existsSync(lock)).toBe(false);
  });

  it('timeout fires when held longer than timeoutMs', async () => {
    const lock = join(tempDir, 'busy.lock');
    const release = await acquireFileMutex(lock);
    await expect(
      acquireFileMutex(lock, { pollIntervalMs: 20, timeoutMs: 100, staleAfterMs: 60_000 }),
    ).rejects.toThrow(/timed out/);
    await release();
  });

  it('concurrent acquires on different paths do not interfere', async () => {
    const lockA = join(tempDir, 'a.lock');
    const lockB = join(tempDir, 'b.lock');
    const [releaseA, releaseB] = await Promise.all([
      acquireFileMutex(lockA),
      acquireFileMutex(lockB),
    ]);
    expect(existsSync(lockA)).toBe(true);
    expect(existsSync(lockB)).toBe(true);
    await releaseA();
    await releaseB();
  });
});

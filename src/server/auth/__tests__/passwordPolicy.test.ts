import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import bcrypt from 'bcryptjs';
import { availableParallelism } from 'node:os';
import { HOST_CONFIG_SETTINGS } from '../../config/hostConfigSettings';
import {
  PasswordHasher, PasswordHasherUnavailableError, createBcryptWorker, readPasswordHasherSettings,
  hashPassword, validatePasswordComplexity, verifyPassword, type PasswordWorker,
} from '../passwordPolicy';

describe('validatePasswordComplexity', () => {
  it('rejects short password', () => {
    const result = validatePasswordComplexity('Ab1!short');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('12 characters');
  });

  it('rejects missing uppercase', () => {
    const result = validatePasswordComplexity('abcdefghijk1!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('uppercase');
  });

  it('rejects missing lowercase', () => {
    const result = validatePasswordComplexity('ABCDEFGHIJK1!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('lowercase');
  });

  it('rejects missing number', () => {
    const result = validatePasswordComplexity('Abcdefghijk!!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('number');
  });

  it('rejects missing special character', () => {
    const result = validatePasswordComplexity('Abcdefghijk12');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('special');
  });

  it('accepts valid password', () => {
    const result = validatePasswordComplexity('MyP@ssw0rd123');
    expect(result.valid).toBe(true);
  });

  it('accepts exactly 12 chars', () => {
    const result = validatePasswordComplexity('Ab1!efghijkl');
    expect(result.valid).toBe(true);
  });

  it('accepts password with unicode', () => {
    const result = validatePasswordComplexity('Abcdefghijk1!é');
    expect(result.valid).toBe(true);
  });

  it('accepts password with spaces', () => {
    const result = validatePasswordComplexity('My Pass w0rd!');
    expect(result.valid).toBe(true);
  });
});

/** The largest gap a 5 ms interval saw while `work` ran — how long the request thread was busy. */
async function loopLagMs(work: () => Promise<unknown>): Promise<number> {
  let max = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 5);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(tick);
  }
  return max;
}

describe('hashPassword / verifyPassword — cost 12, off the request thread', () => {
  it('a cost-12 hash verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('Right-password-1');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword('Right-password-1', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    // Paired control: the hash is a real bcrypt hash the library itself accepts.
    expect(bcrypt.compareSync('Right-password-1', hash)).toBe(true);
  }, 30_000);

  it('three concurrent compares leave the event loop responsive — measured against the same three on the loop', async () => {
    const hash = await hashPassword('Right-password-1');
    const onLoop = await loopLagMs(() => Promise.all([1, 2, 3].map(() => bcrypt.compare('Right-password-1', hash))));
    const offLoop = await loopLagMs(() => Promise.all([1, 2, 3].map(() => verifyPassword('Right-password-1', hash))));
    expect(onLoop).toBeGreaterThan(100);
    expect(offLoop * 3).toBeLessThan(onLoop);
  }, 30_000);
});

/** A worker that answers nothing by itself; the test drives it. */
function fakeWorker(onJob: (worker: EventEmitter, job: { id: number }) => void): PasswordWorker & { terminated: boolean } {
  const emitter = new EventEmitter();
  const worker = Object.assign(emitter, {
    terminated: false,
    postMessage: (job: { id: number }) => queueMicrotask(() => onJob(emitter, job)),
    terminate: async () => { worker.terminated = true; emitter.emit('exit', 1); return 1; },
    unref: () => undefined,
  });
  return worker as unknown as PasswordWorker & { terminated: boolean };
}
const settings = { workers: 1, maxQueue: 2, timeoutMs: 200, idleMs: 60_000 };

describe('PasswordHasher — a pool that cannot answer refuses, never matches', () => {
  it('a worker that dies mid-compare rejects the job, and the next job gets a fresh worker', async () => {
    let spawned = 0;
    const pool = new PasswordHasher({
      settings: () => settings,
      createWorker: () => {
        spawned += 1;
        return spawned === 1
          ? fakeWorker((w) => w.emit('exit', 1))
          : fakeWorker((w, job) => w.emit('message', { id: job.id, ok: true, value: true }));
      },
    });
    await expect(pool.compare('x', 'h')).rejects.toBeInstanceOf(PasswordHasherUnavailableError);
    expect(await pool.compare('x', 'h')).toBe(true);
    expect(spawned).toBe(2);
    await pool.close();
  });

  it('the real worker over a module that does not load rejects', async () => {
    const pool = new PasswordHasher({ settings: () => settings, createWorker: () => createBcryptWorker('/nonexistent/bcryptjs.js') });
    await expect(pool.compare('x', '$2b$12$D0q5piEtIifCQCqy0jjWx.01dayJ8hrVR1csHDvM4l7XcSzd1ohwm')).rejects.toBeInstanceOf(PasswordHasherUnavailableError);
    await pool.close();
  }, 30_000);

  it('a worker that refuses the job, a hung worker and a full queue all reject — the hung one is replaced', async () => {
    const refusing = new PasswordHasher({ settings: () => settings, createWorker: () => fakeWorker((w, job) => w.emit('message', { id: job.id, ok: false })) });
    await expect(refusing.compare('x', 'h')).rejects.toThrow(/refused the job/);
    await refusing.close();

    const hung: Array<ReturnType<typeof fakeWorker>> = [];
    const stuck = new PasswordHasher({ settings: () => settings, createWorker: () => { const w = fakeWorker(() => undefined); hung.push(w); return w; } });
    const jobs = [stuck.compare('a', 'h'), stuck.compare('b', 'h'), stuck.compare('c', 'h')];
    await expect(stuck.compare('d', 'h')).rejects.toThrow(/queue full/);
    await expect(jobs[0]).rejects.toThrow(/timed out/);
    for (const job of jobs.slice(1)) await expect(job).rejects.toBeInstanceOf(PasswordHasherUnavailableError);
    expect(hung[0]!.terminated).toBe(true);
    await stuck.close();
  });

  it('the bounds are read per job: an edit applies to the next one', async () => {
    const live = { ...settings };
    const pool = new PasswordHasher({ settings: () => live, createWorker: () => fakeWorker((w, job) => w.emit('message', { id: job.id, ok: true, value: true })) });
    expect(await pool.compare('x', 'h')).toBe(true);
    live.maxQueue = 0;
    await expect(pool.compare('x', 'h')).rejects.toThrow(/queue full/);
    await pool.close();
  });

  it('a startup that throws rejects the job', async () => {
    const pool = new PasswordHasher({ settings: () => settings, createWorker: () => { throw new Error('no worker'); } });
    await expect(pool.hash('x')).rejects.toThrow(/failed to start/);
  });

  it('the pool bounds are the declared host keys; the worker count never passes the cores beside the request thread', () => {
    const d = readPasswordHasherSettings();
    const declared = (key: string): unknown => HOST_CONFIG_SETTINGS.find((s) => s.key === key)?.default;
    expect(d.workers).toBeGreaterThanOrEqual(1);
    expect(d.workers).toBeLessThanOrEqual(Math.max(1, Math.min(Number(declared('passwordHashWorkers')), availableParallelism() - 1)));
    expect(d).toMatchObject({ maxQueue: declared('passwordHashQueueMax'), timeoutMs: declared('passwordHashTimeoutMs'), idleMs: declared('passwordHashWorkerIdleMs') });
  });
});

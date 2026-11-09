/**
 * Passwords: the complexity rule, and the ONE place a password is hashed or
 * compared on the server.
 *
 * A cost-12 bcrypt run is ~330 ms of pure CPU. On the request thread it stalls
 * every request in flight, so `hashPassword` / `verifyPassword` run it on a
 * small worker pool. Two floors ride along and are not negotiable for latency:
 * the cost stays `PASSWORD_HASH_COST`, and a caller that compares against a
 * dummy hash for an unknown account pays the same pool and the same cost as a
 * real compare. A pool that cannot answer — a full queue, a worker that died
 * or hung — REJECTS with `PasswordHasherUnavailableError`: a refused login,
 * never an accepted one.
 */

import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { HOST_ROOT } from '../host/builtinSlots';
import { HOST_CONFIG_SETTINGS } from '../config/hostConfigSettings';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';

export type PasswordValidationResult = { valid: true } | { valid: false; reason: string };

export function validatePasswordComplexity(password: string): PasswordValidationResult {
  if (password.length < 12) return { valid: false, reason: 'Password must be at least 12 characters' };
  if (!/[A-Z]/.test(password)) return { valid: false, reason: 'Password must contain an uppercase letter' };
  if (!/[a-z]/.test(password)) return { valid: false, reason: 'Password must contain a lowercase letter' };
  if (!/[0-9]/.test(password)) return { valid: false, reason: 'Password must contain a number' };
  if (!/[^A-Za-z0-9]/.test(password)) return { valid: false, reason: 'Password must contain a special character' };
  return { valid: true };
}

/** The bcrypt cost of every stored hash — a security floor, never a tunable. */
export const PASSWORD_HASH_COST = 12;

/** The hashing pool could not answer; the caller refuses (never treats it as a match). */
export class PasswordHasherUnavailableError extends Error {
  constructor(reason: string) {
    super(`Password hashing unavailable: ${reason}`);
    this.name = 'PasswordHasherUnavailableError';
  }
}

type HashJob =
  | { id: number; op: 'compare'; password: string; hash: string }
  | { id: number; op: 'hash'; password: string; cost: number };
type HashReply = { id: number; ok: true; value: boolean | string } | { id: number; ok: false };

/** The slice of `node:worker_threads` `Worker` the pool drives. */
export type PasswordWorker = {
  postMessage(job: HashJob): void;
  on(event: 'message', listener: (reply: HashReply) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
};

export type PasswordHasherSettings = {
  /** Most workers alive at once. */
  workers: number;
  /** Most jobs waiting for a worker; one more is refused. */
  maxQueue: number;
  /** Per job, from enqueue to answer; past it the job is refused and its worker replaced. */
  timeoutMs: number;
  /** An idle worker is terminated after this long. */
  idleMs: number;
};

/**
 * The worker body, run with `eval` so there is no file for `next build`'s
 * tracer to miss: the image and the native bundle both resolve `bcryptjs`
 * from the host root (`workerData.bcryptPath`), the same root builtin
 * discovery resolves from.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (job) => {
  let reply;
  try {
    reply = job.op === 'compare'
      ? { id: job.id, ok: true, value: bcrypt.compareSync(job.password, job.hash) }
      : { id: job.id, ok: true, value: bcrypt.hashSync(job.password, job.cost) };
  } catch {
    reply = { id: job.id, ok: false };
  }
  parentPort.postMessage(reply);
});
`;

type Pending = {
  job: HashJob;
  settle: (reply: HashReply | PasswordHasherUnavailableError) => void;
  deadline: ReturnType<typeof setTimeout>;
};
type Slot = { worker: PasswordWorker; current: Pending | null; idle: ReturnType<typeof setTimeout> | null; dead: boolean };

export class PasswordHasher {
  readonly #createWorker: () => PasswordWorker;
  readonly #settings: () => PasswordHasherSettings;
  readonly #slots = new Set<Slot>();
  readonly #queue: Pending[] = [];
  #nextId = 1;

  /** `settings` is read per job, so an admin edit applies to the next login. */
  constructor(deps: { createWorker: () => PasswordWorker; settings: () => PasswordHasherSettings }) {
    this.#createWorker = deps.createWorker;
    this.#settings = deps.settings;
  }

  /** Live workers — the memory the pool holds right now. */
  get workerCount(): number {
    return this.#slots.size;
  }

  async compare(password: string, hash: string): Promise<boolean> {
    const value = await this.#run({ op: 'compare', password, hash });
    if (typeof value !== 'boolean') throw new PasswordHasherUnavailableError('malformed answer');
    return value;
  }

  async hash(password: string): Promise<string> {
    const value = await this.#run({ op: 'hash', password, cost: PASSWORD_HASH_COST });
    if (typeof value !== 'string') throw new PasswordHasherUnavailableError('malformed answer');
    return value;
  }

  /** Terminate every worker and refuse every open job. */
  async close(): Promise<void> {
    for (const pending of this.#queue.splice(0)) this.#finish(pending, new PasswordHasherUnavailableError('closed'));
    await Promise.all([...this.#slots].map((slot) => {
      if (slot.current) this.#finish(slot.current, new PasswordHasherUnavailableError('closed'));
      return this.#retire(slot);
    }));
  }

  #run(input: { op: 'compare'; password: string; hash: string } | { op: 'hash'; password: string; cost: number }): Promise<boolean | string> {
    const settings = this.#settings();
    if (this.#queue.length >= settings.maxQueue) {
      return Promise.reject(new PasswordHasherUnavailableError('queue full'));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        job: { id: this.#nextId++, ...input },
        settle: (reply) => {
          if (reply instanceof PasswordHasherUnavailableError) reject(reply);
          else if (!reply.ok) reject(new PasswordHasherUnavailableError('the worker refused the job'));
          else resolve(reply.value);
        },
        deadline: setTimeout(() => this.#expire(pending), settings.timeoutMs),
      };
      this.#queue.push(pending);
      this.#pump(settings);
    });
  }

  #pump(settings: PasswordHasherSettings = this.#settings()): void {
    while (this.#queue.length > 0) {
      let slot = [...this.#slots].find((candidate) => candidate.current === null && !candidate.dead);
      if (!slot) {
        if (this.#slots.size >= settings.workers) return;
        try {
          slot = this.#spawn(settings);
        } catch {
          const pending = this.#queue.shift();
          if (pending) this.#finish(pending, new PasswordHasherUnavailableError('the worker failed to start'));
          continue;
        }
      }
      const pending = this.#queue.shift();
      if (!pending) return;
      if (slot.idle) clearTimeout(slot.idle);
      slot.idle = null;
      slot.current = pending;
      slot.worker.postMessage(pending.job);
    }
  }

  #spawn(settings: PasswordHasherSettings): Slot {
    const worker = this.#createWorker();
    worker.unref();
    const slot: Slot = { worker, current: null, idle: null, dead: false };
    worker.on('message', (reply) => {
      const pending = slot.current;
      if (!pending || reply.id !== pending.job.id) return;
      slot.current = null;
      this.#finish(pending, reply);
      if (!slot.dead) slot.idle = setTimeout(() => void this.#retire(slot), settings.idleMs);
      this.#pump();
    });
    const lost = (): void => {
      if (slot.dead) return;
      slot.dead = true;
      this.#slots.delete(slot);
      if (slot.idle) clearTimeout(slot.idle);
      const pending = slot.current;
      slot.current = null;
      if (pending) this.#finish(pending, new PasswordHasherUnavailableError('the worker stopped'));
      this.#pump();
    };
    worker.on('error', lost);
    worker.on('exit', lost);
    this.#slots.add(slot);
    return slot;
  }

  #expire(pending: Pending): void {
    const queued = this.#queue.indexOf(pending);
    if (queued >= 0) this.#queue.splice(queued, 1);
    const slot = [...this.#slots].find((candidate) => candidate.current === pending);
    this.#finish(pending, new PasswordHasherUnavailableError('timed out'));
    // A worker past the deadline may be wedged: it is replaced, never reused.
    if (slot) {
      slot.current = null;
      void this.#retire(slot);
    }
    this.#pump();
  }

  #finish(pending: Pending, reply: HashReply | PasswordHasherUnavailableError): void {
    clearTimeout(pending.deadline);
    pending.settle(reply);
  }

  async #retire(slot: Slot): Promise<void> {
    slot.dead = true;
    this.#slots.delete(slot);
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    await slot.worker.terminate().catch(() => 0);
  }
}

let hostBcryptEntry: string | undefined;

/** `bcryptjs` resolved from the host root — the root builtin discovery resolves from, in the image and the native bundle alike. */
function resolveHostBcryptEntry(): string {
  hostBcryptEntry ??= createRequire(join(HOST_ROOT, 'package.json')).resolve('bcryptjs');
  return hostBcryptEntry;
}

/**
 * The production worker: the eval body over `bcryptjs`, a small heap ceiling.
 * `bcryptPath` is a parameter so a test can prove a module that does not load
 * is a refusal.
 */
export function createBcryptWorker(bcryptPath: string = resolveHostBcryptEntry()): PasswordWorker {
  return new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { bcryptPath },
    resourceLimits: { maxOldGenerationSizeMb: 32 },
  });
}

/** A host config key's value; before the store is registered, its DECLARED default (one literal, in `hostConfigSettings.ts`). */
function hostNumber(key: string): number {
  const declared = Number(HOST_CONFIG_SETTINGS.find((setting) => setting.key === key)?.default);
  try {
    const value = Number(getPlatformConfigStore().get(key));
    return Number.isFinite(value) && value > 0 ? value : declared;
  } catch {
    return declared;
  }
}

/**
 * The pool's bounds from the `passwordHash*` host keys. The worker count never
 * exceeds the cores past the request thread, whatever the key says; the login
 * limiter brakes a spray, the queue only bounds memory.
 */
export function readPasswordHasherSettings(): PasswordHasherSettings {
  return {
    workers: Math.max(1, Math.min(Math.floor(hostNumber('passwordHashWorkers')), availableParallelism() - 1)),
    maxQueue: Math.floor(hostNumber('passwordHashQueueMax')),
    timeoutMs: hostNumber('passwordHashTimeoutMs'),
    idleMs: hostNumber('passwordHashWorkerIdleMs'),
  };
}

const POOL_KEY = Symbol.for('@neuralis/host:passwordHasher');

function pool(): PasswordHasher {
  const scope = globalThis as typeof globalThis & { [POOL_KEY]?: PasswordHasher };
  scope[POOL_KEY] ??= new PasswordHasher({ createWorker: createBcryptWorker, settings: readPasswordHasherSettings });
  return scope[POOL_KEY];
}

/** bcrypt-compare `password` with `hash` off the request thread; rejects (never `true`) when the pool cannot answer. */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return pool().compare(password, hash);
}

/** A cost-`PASSWORD_HASH_COST` bcrypt hash of `password`, off the request thread. */
export function hashPassword(password: string): Promise<string> {
  return pool().hash(password);
}

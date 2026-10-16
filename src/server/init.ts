import { readdir } from 'fs/promises';
import { join } from 'path';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { hasSessionSecret } from './config/env';

export class SetupRequiredError extends Error {
  readonly code = 'SETUP_REQUIRED';

  constructor(message = 'Neuralis setup has not been completed. Run `npx neuralis setup` first.') {
    super(message);
    this.name = 'SetupRequiredError';
  }
}

/** Closed set — it reaches `/api/health` as `code`, so it never carries a path or a value. */
export type SetupIncompleteReason = 'secret_missing' | 'setup_incomplete';

export type SetupState =
  | { configured: true }
  | { configured: false; reason: SetupIncompleteReason };

const CONFIGURED: SetupState = { configured: true };

/** How long a NEGATIVE answer is reused before the disk is asked again. */
const NEGATIVE_RECHECK_MS = 2_000;

type SetupStateSlot = {
  /** Latched once true: a configured instance never flips back while it runs. */
  configured: boolean;
  last: SetupState | null;
  checkedAt: number;
  pending: Promise<SetupState> | null;
};

// `globalThis`-anchored: the proxy, the route handlers and `instrumentation.ts`
// are compiled into separate server graphs, and they must share one latch.
const SETUP_STATE_SLOT = Symbol.for('@neuralis/host:setupState');

function slot(): SetupStateSlot {
  const g = globalThis as { [SETUP_STATE_SLOT]?: SetupStateSlot };
  return (g[SETUP_STATE_SLOT] ??= { configured: false, last: null, checkedAt: 0, pending: null });
}

/**
 * The per-request question, answered without I/O: true only after
 * {@link getSetupState} has seen a configured instance once.
 */
export function isSetupLatched(): boolean {
  return slot().configured;
}

/**
 * Whether this instance is set up: the session secret is present (never
 * generated) AND setup has written at least one user record. Projects are not
 * part of it — an owner may purge the last project without the instance
 * turning "unconfigured". The roots come from the kernel resolver, not
 * `getEnv()`, so the answer exists while the secret is missing.
 */
export async function getSetupState(): Promise<SetupState> {
  const state = slot();
  if (state.configured) return CONFIGURED;
  if (state.last && Date.now() - state.checkedAt < NEGATIVE_RECHECK_MS) return state.last;
  state.pending ??= readSetupState().then((result) => {
    state.last = result;
    state.checkedAt = Date.now();
    if (result.configured) state.configured = true;
    return result;
  }).finally(() => {
    state.pending = null;
  });
  return state.pending;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await getSetupState()).configured;
}

export async function assertSetupComplete(): Promise<void> {
  if (!await isSetupComplete()) {
    throw new SetupRequiredError();
  }
}

async function readSetupState(): Promise<SetupState> {
  if (!hasSessionSecret()) return { configured: false, reason: 'secret_missing' };
  const { appRoot } = resolveNeuralisHome();
  const userFiles = await listJsonFiles(join(appRoot, 'users'));
  return userFiles.length > 0 ? CONFIGURED : { configured: false, reason: 'setup_incomplete' };
}

async function listJsonFiles(target: string): Promise<string[]> {
  try {
    const entries = await readdir(target);
    return entries.filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
}

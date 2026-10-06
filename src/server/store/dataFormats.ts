/**
 * The HOST's own durable record kinds, declared into the kernel data-format
 * ledger (`@neuralis/package-system/data`), and the ONE host claim over them.
 *
 * Every owner declares its own kinds — packages from their store modules, the
 * host here — and the host runs the generic `claimDeclared` so a binary never
 * reads (and then rewrites) data a NEWER binary wrote. The host names no
 * package's kind: `claimAllDeclaredDataFormats` claims whatever is declared,
 * by registry, not by name.
 *
 * Two lines of defence, both order-free:
 *  - `ensureHostDataFormat(kind)` — the host stores a request can reach before
 *    the bootstrap (project, user, credential) await it before their first
 *    operation. The first caller runs the claim ONCE per process; afterwards it
 *    is a resolved promise plus the kernel's memoized Map lookup. The usage and
 *    rule stores are built BY the bootstrap, after its claim.
 *  - `claimAllDeclaredDataFormats()` — the bootstrap, before its first store
 *    read and again after the package loader evaluated every package, claims
 *    every declared kind and asserts none was left unclaimed: a missing
 *    declaration stops the boot, it never warns.
 *
 * `files` are RELATIVE to NEURALIS_HOME — what the checkpoint taken before a
 * kind is raised copies. Logs carry none (they are append-only and never
 * restored); the credential blobs and the master key ride only the credential
 * kind, so a raise of any other kind never copies a secret.
 *
 * The memo lives on `globalThis` + `Symbol.for`: Next loads this module in the
 * bootstrap graph and in every route graph, and a per-graph memo would claim
 * twice (harmless) but also let a route graph reach a store before any claim.
 */

import {
  assertAllClaimed,
  claimDataFormat,
  claimDeclared,
  declareDataFormats,
  DataFormatNewerError,
  type DataFormatClaimReport,
  type DataFormatDeclaration,
} from '@neuralis/package-system/data';
import { dirname } from 'node:path';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from './PlatformConfigStore';

/** Kind name → declaration. The version is the on-disk format this build reads and writes. */
export const HOST_DATA_FORMATS = {
  project: { kind: 'neuralis/project', version: 1, files: ['app/projects'] },
  projectPurged: { kind: 'neuralis/project-purged', version: 1, files: ['app/projects-purged'] },
  user: { kind: 'neuralis/user', version: 1, files: ['app/users'] },
  credential: {
    kind: 'neuralis/credential',
    version: 1,
    files: [
      'app/credentials/global',
      'app/credentials/users',
      'app/credentials/projects',
      'app/credentials/agents',
      'app/config/credential-master.key',
      'app/config/credential-salt.bin',
    ],
  },
  credentialUsage: { kind: 'neuralis/credential-usage', version: 1, files: ['app/credentials/usage'] },
  credentialUseRules: {
    kind: 'neuralis/credential-use-rules',
    version: 1,
    files: ['app/credentials/credential-use-rules.json'],
  },
  platformConfig: { kind: 'neuralis/platform-config', version: 1, files: ['app/config/platform.json'] },
  auditLog: { kind: 'neuralis/audit-log', version: 1, files: [] },
  routeLog: { kind: 'neuralis/route-log', version: 1, files: [] },
} as const satisfies Record<string, DataFormatDeclaration>;

export type HostDataFormat = (typeof HOST_DATA_FORMATS)[keyof typeof HOST_DATA_FORMATS];

declareDataFormats(Object.values(HOST_DATA_FORMATS));

/** The operator command that puts a checkpoint back (host plane, app stopped). */
export const CHECKPOINT_RESTORE_COMMAND = 'pnpm neuralis:checkpoint restore';
/** The same, inside the image (a pulled image has no host folder). */
export const CHECKPOINT_RESTORE_DOCKER_COMMAND =
  'docker compose run --rm --no-deps neuralis node --import tsx scripts/checkpoint.mts restore';

type ClaimSlot = { boot?: Promise<DataFormatClaimReport> };
const CLAIM_SLOT = Symbol.for('@neuralis/host:dataFormatClaim');

function claimSlot(): ClaimSlot {
  const g = globalThis as { [CLAIM_SLOT]?: ClaimSlot };
  return (g[CLAIM_SLOT] ??= {});
}

function claimOptions(): { home: string; appRoot: string; checkpointKeep?: number } {
  // The SAME roots every host store reads through (`getEnv()` caches
  // `resolveNeuralisHome()`), so the ledger always sits beside the records it
  // guards. `getEnv()` also registers the host keys; reading one is a READ-ONLY
  // file read — `get()` never rewrites `platform.json` (only `patch`/`removeOverride`
  // write it), so it may precede the `neuralis/platform-config` claim.
  const { appRoot } = getEnv();
  const home = dirname(appRoot);
  const config = getPlatformConfigStore(appRoot);
  // Registered by `getEnv()` on every real host; a store whose env was never
  // built (an isolated unit test) keeps every checkpoint instead of throwing.
  const keep = config.getRegisteredSetting('dataCheckpointKeep') ? config.get('dataCheckpointKeep') : undefined;
  // A hand-edited non-integer is not guessed at: the kernel then keeps every
  // checkpoint (its documented "no retention" arm), which loses nothing.
  return {
    home,
    appRoot,
    ...(typeof keep === 'number' && Number.isInteger(keep) && keep >= 1 ? { checkpointKeep: keep } : {}),
  };
}

/**
 * Re-throw a newer-data refusal with what the operator needs in ONE line: the
 * kind(s), both versions, the newest checkpoint and the exact restore command.
 * Every other error passes through unchanged.
 */
export function describeDataFormatRefusal(error: unknown): unknown {
  if (!(error instanceof DataFormatNewerError)) return error;
  const kinds = error.newer.map((n) => `${n.kind} v${n.stored} (this build reads v${n.codeVersion})`).join(', ');
  const restore = error.checkpoint
    ? ` Newest checkpoint: ${error.checkpoint}. With the app stopped, restore it with ` +
      `\`${CHECKPOINT_RESTORE_COMMAND} ${error.checkpoint}\` ` +
      `(Docker: \`${CHECKPOINT_RESTORE_DOCKER_COMMAND} ${error.checkpoint}\`), then start this build.`
    : ' No checkpoint exists; run the build that wrote this data.';
  return new Error(`Stored data is newer than this build: ${kinds}. Nothing was changed.${restore}`, {
    cause: error,
  });
}

/**
 * The boot claim, once per process. Claims every kind declared so far (at
 * least the host's own) and records the roots, so a kind a package declares
 * later is claimed by its own store's first `claimDataFormat`.
 */
export function claimHostDataFormats(): Promise<DataFormatClaimReport> {
  const slot = claimSlot();
  if (!slot.boot) {
    const attempt = (async () => {
      try {
        return await claimDeclared(claimOptions());
      } catch (error) {
        throw describeDataFormatRefusal(error);
      }
    })();
    slot.boot = attempt;
    // A failed claim wrote nothing; drop the memo so the next boot attempt
    // re-reads the ledger instead of replaying a stale rejection.
    attempt.catch(() => {
      if (slot.boot === attempt) slot.boot = undefined;
    });
  }
  return slot.boot;
}

/** Every host store awaits this before its first operation. */
export async function ensureHostDataFormat(format: HostDataFormat): Promise<void> {
  await claimHostDataFormats();
  try {
    await claimDataFormat(format.kind, format.version);
  } catch (error) {
    throw describeDataFormatRefusal(error);
  }
}

/**
 * After every package ran `init`: claim every declared kind, then assert none
 * is left unclaimed. Either failure stops the boot.
 */
export async function claimAllDeclaredDataFormats(): Promise<DataFormatClaimReport> {
  await claimHostDataFormats();
  try {
    const report = await claimDeclared(claimOptions());
    assertAllClaimed();
    return report;
  } catch (error) {
    throw describeDataFormatRefusal(error);
  }
}

/** Test seam: forget this process's boot claim. Never call in production. */
export function resetHostDataFormatClaimForTesting(): void {
  delete (globalThis as { [CLAIM_SLOT]?: ClaimSlot })[CLAIM_SLOT];
}

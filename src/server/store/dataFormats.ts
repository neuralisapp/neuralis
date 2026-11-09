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
 * `files` are RELATIVE to NEURALIS_HOME — where each kind's records live. The
 * boot claim never raises a kind and never checkpoints (a kind above v1 is
 * raised only by `pnpm neuralis:upgrade`, which checkpoints what its module's
 * dry run names). Logs carry none; the credential blobs and the master key are
 * named by the credential kind alone.
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
  DataFormatClaimError,
  DataFormatNewerError,
  type DataFormatClaimFailure,
  type DataFormatClaimReport,
  type DataFormatDeclaration,
} from '@neuralis/package-system/data';
import { dirname } from 'node:path';
import { getEnv } from '../config/env';

/**
 * `neuralis/project`'s offline chain, in order: the package-identity upgrade
 * (v2), then the device upgrade, whose role-grant raise gives `device.own` to
 * every stored builtin role the manifests grant it (v3, role-grant revision
 * 20), then the two-word feature ids on every stored role, custom roles and
 * package overrides included (v4, role-grant revision 21), then an agent
 * level on every stored role that names none (v5, role-grant revision 22 —
 * `roleGrantFormatLockstep.test.ts`). Each step stamps the revision IT
 * produces, never the live one.
 */
export const PROJECT_UPGRADE_STEPS = {
  identity: { to: 2, id: 'package-identity-v2' },
  device: { to: 3, id: 'source-device-v1' },
  features: { to: 4, id: 'two-word-features-v1' },
  agents: { to: 5, id: 'written-role-agents-v1' },
} as const;

/** Kind name → declaration. The version is the on-disk format this build reads and writes. */
export const HOST_DATA_FORMATS = {
  project: {
    kind: 'neuralis/project',
    version: 5,
    files: ['app/projects'],
    upgrade: [PROJECT_UPGRADE_STEPS.identity, PROJECT_UPGRADE_STEPS.device, PROJECT_UPGRADE_STEPS.features, PROJECT_UPGRADE_STEPS.agents],
  },
  projectPurged: { kind: 'neuralis/project-purged', version: 1, files: ['app/projects-purged'] },
  user: { kind: 'neuralis/user', version: 1, files: ['app/users'] },
  invite: { kind: 'neuralis/invite', version: 1, files: ['app/invites'] },
  // v2: every blob opens under the key file + salt file alone (no NEXTAUTH_SECRET or static-salt
  // fallback); raised by the `credential-key-v2` upgrade, whose dry run names any blob that does not.
  credential: {
    kind: 'neuralis/credential',
    version: 2,
    upgrade: { mode: 'offline', id: 'credential-key-v2' },
    files: [
      'app/credentials/global',
      'app/credentials/users',
      'app/credentials/projects',
      'app/credentials/agents',
      'app/config/credential-master.key',
      'app/config/credential-salt.bin',
    ],
  },
  // The session secret file (`config/sessionSecretFile.ts`). v1 is its first format, raised OFFLINE
  // (`session-secret-v1` writes it from the `.env` an older install kept it in): an existing ledger
  // without this kind refuses to boot until that step ran, a fresh install claims v1 directly.
  sessionSecret: {
    kind: 'neuralis/session-secret',
    version: 1,
    upgrade: { mode: 'offline', id: 'session-secret-v1' },
    files: ['app/config/session-secret.key'],
  },
  credentialUsage: { kind: 'neuralis/credential-usage', version: 1, files: ['app/credentials/usage'] },
  credentialUseRules: {
    kind: 'neuralis/credential-use-rules',
    version: 1,
    files: ['app/credentials/credential-use-rules.json'],
  },
  // v2: the retired keys no build reads are gone (`platform-config-v2`) — the store refuses to
  // write or delete an unregistered key, so only the offline module can drop them.
  platformConfig: {
    kind: 'neuralis/platform-config',
    version: 2,
    upgrade: { mode: 'offline', id: 'platform-config-v2' },
    files: ['app/config/platform.json'],
  },
  auditLog: { kind: 'neuralis/audit-log', version: 1, files: [] },
  routeLog: { kind: 'neuralis/route-log', version: 1, files: [] },
} as const satisfies Record<string, DataFormatDeclaration>;

export type HostDataFormat = (typeof HOST_DATA_FORMATS)[keyof typeof HOST_DATA_FORMATS];

declareDataFormats(Object.values(HOST_DATA_FORMATS));

/** The operator command that puts a checkpoint back (on the machine, app stopped). */
export const CHECKPOINT_RESTORE_COMMAND = 'npx neuralis checkpoint restore';
/** The same for an image-only folder: the `neuralis` command runs it in the image. */
export const CHECKPOINT_RESTORE_DOCKER_COMMAND = 'neuralis checkpoint restore';

type ClaimSlot = { boot?: Promise<DataFormatClaimReport> };
const CLAIM_SLOT = Symbol.for('@neuralis/host:dataFormatClaim');

function claimSlot(): ClaimSlot {
  const g = globalThis as { [CLAIM_SLOT]?: ClaimSlot };
  return (g[CLAIM_SLOT] ??= {});
}

function claimOptions(): { home: string; appRoot: string } {
  // The SAME roots every host store reads through (`getEnv()` caches
  // `resolveNeuralisHome()`), so the ledger always sits beside the records it
  // guards.
  const { appRoot } = getEnv();
  return { home: dirname(appRoot), appRoot };
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
      `(an image-only folder: \`${CHECKPOINT_RESTORE_DOCKER_COMMAND} ${error.checkpoint}\`), then start this build.`
    : ' No checkpoint exists; run the build that wrote this data.';
  return new Error(`Stored data is newer than this build: ${kinds}. Nothing was changed.${restore}`, {
    cause: error,
  });
}

/** The closed set of data-format refusal codes a public health answer may carry. */
export type DataFormatRefusalCode = DataFormatClaimFailure | DataFormatNewerError['code'];

/**
 * The FIXED code of a data-format refusal (the raw claim error, or the
 * newer-data refusal {@link describeDataFormatRefusal} wraps), or `null` for any
 * other error. Never a kind, a version, a checkpoint id or a path — those stay
 * in the operator log.
 */
export function dataFormatRefusalCode(error: unknown): DataFormatRefusalCode | null {
  if (error instanceof DataFormatClaimError) return error.reason;
  const newer = error instanceof Error && error.cause instanceof DataFormatNewerError ? error.cause : error;
  return newer instanceof DataFormatNewerError ? newer.code : null;
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

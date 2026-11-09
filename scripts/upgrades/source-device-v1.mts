/**
 * Offline upgrade `source-device-v1`: the server's host access moves onto paired devices.
 *
 * Until this build ONE host broker served the server's own machine, reached
 * through a compose bind. Now every machine is a paired device, the server's
 * broker included (the operator device), and `neuralis device run` dials the app
 * instead. On a stopped app this module, in order:
 *
 *  (i)   registers the operator device from the broker secret the server
 *        already holds (`<home>/host-broker/secret`, or `<home>/device/secret`
 *        once `neuralis device install` moved it), and writes
 *        `<home>/device/device.json` (`{host, link, deviceId, name}`) so
 *        `neuralis device install` on the server adopts it without pairing again;
 *  (ii)  stamps that device into every host source config, and
 *  (iii) into every host background-shell record (agent-core's algorithm);
 *  (iv)  raises `neuralis/project` to the device step of its chain: the stored
 *        builtin roles the manifests grant `device.own` get it (role-grant
 *        revision 20); a deliberately revoked grant of any other feature is
 *        never re-added — only this one id is;
 *  (v)   the owner: `NEURALIS_DEVICE_OWNER=<userId>` when set, else the ONE
 *        real user the host sources name. No user, several, or the `operator`
 *        literal of an old `host-broker attach` ⇒ the module stops and asks.
 *
 * File name: sorts after `package-zone-v1.mts`, the chain order of
 * `neuralis/project` (the identity step first). The way back is the checkpoint
 * the command takes — an older build drops a device-stamped host config and
 * refuses to start on the raised project format.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { isSafePathSegment } from '@neuralis/package-system/paths';
import { isSentinelId, SKILL_USER_ID } from '@neuralis/package-system/contracts';
import {
  DEVICE_OWN_FEATURE,
  SOURCE_DEVICE_AGENT_CORE_KINDS,
  applySourceDevice,
  deviceRegistryRoot,
  inspectSourceDevice,
  operatorDeviceId,
  type OperatorDeviceInput,
  type SourceDeviceCensus,
} from '@neuralis/agent-core/upgrade';
import { HOST_DATA_FORMATS, PROJECT_UPGRADE_STEPS } from '../../src/server/store/dataFormats';
import { sessionEpochOf } from '../../src/server/store/UserStore';
import { getDefaultRoleFeatures } from '../../src/server/host/builtinFeatures';
import { resolveTrustedAppOrigin } from '../../src/server/oauth/appOrigin';
import { mcpHttpPort } from '../../src/server/mcp/mcpBaseUrl';

/**
 * The role-grant revision THIS step produces. A chained step pins its own and
 * never imports the live `ROLE_GRANT_VERSION`: a later step raises the live one,
 * and this step must still stamp what IT wrote, or the next step skips the record.
 */
const ROLE_GRANT_REVISION = 20;

/** The env var that names the operator device's owner when the host sources cannot. */
export const DEVICE_OWNER_ENV = 'NEURALIS_DEVICE_OWNER';
/** What an old `host-broker attach` wrote as `createdBy` without a user — never an owner. */
const OPERATOR_LITERAL = 'operator';
const DEVICE_NAME = 'Neuralis server';

const REMEDY =
  `run the upgrade on the server, where its broker secret lives (\`neuralis upgrade --apply\` — in an image-only folder it binds the data home's \`host-broker\` and \`device\` folders into its run of the app service); ` +
  `name the operator device's owner with ${DEVICE_OWNER_ENV}=<userId> when the host sources do not name exactly one user; ` +
  'or remove the host source in the running app first';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The broker secret the server already holds: the old layout first, then the one `device install` moves it to. */
export async function readOperatorSecret(home: string): Promise<{ secret: string; file: string } | null> {
  for (const file of [join(home, 'host-broker', 'secret'), join(home, 'device', 'secret')]) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    return { secret: text.trim(), file };
  }
  return null;
}

/** A user of this install: a record under `app/users/` that is not a tombstone, and never a sentinel or the `operator` literal. */
async function realUser(appRoot: string, userId: string): Promise<Json | null> {
  if (userId === OPERATOR_LITERAL || userId === SKILL_USER_ID || isSentinelId(userId) || !isSafePathSegment(userId)) return null;
  try {
    const record = JSON.parse(await readFile(join(appRoot, 'users', `${userId}.json`), 'utf8')) as unknown;
    return isObject(record) && record.id === userId && record.status !== 'deleted' ? record : null;
  } catch {
    return null;
  }
}

/** `<home>/device/device.json` — the one-host identity `neuralis device install` moves into its host's folder. */
export function deviceIdentityFile(home: string): string {
  return join(home, 'device', 'device.json');
}

/** What the server's device links to: the app's origin and the device link on its loopback MCP port. */
export function operatorIdentity(deviceId: string, env: Readonly<Record<string, string | undefined>> = process.env): { host: string; link: string; deviceId: string; name: string } {
  return { host: resolveTrustedAppOrigin(), link: `ws://127.0.0.1:${mcpHttpPort(env)}/ws/device-link`, deviceId, name: DEVICE_NAME };
}

type GrantRow = { file: string; next: Json; roles: string[] };

/**
 * (iv) The role-grant raise: every seeded record below the current revision.
 * The roles that gain `device.own` are the builtin roles whose manifest default
 * grants include it (derived, never a list here); a role holding `*` already has
 * it. An unseeded record is seeded at the current revision on its first read.
 */
async function inspectGrants(ctx: OfflineUpgradeContext): Promise<GrantRow[]> {
  const dir = join(ctx.appRoot, 'projects');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const defaults = getDefaultRoleFeatures();
  const granted = new Set(Object.keys(defaults).filter((role) => defaults[role]!.includes(DEVICE_OWN_FEATURE)));
  const rows: GrantRow[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const record = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isObject(record)) throw new Error(`${relative(ctx.home, path)} is not a project record`);
    const version = typeof record.roleGrantVersion === 'number' ? record.roleGrantVersion : undefined;
    const roles = isObject(record.roles) ? record.roles : {};
    if (version === undefined && Object.keys(roles).length === 0) continue; // unseeded: born current on its first read
    if (version !== undefined && version >= ROLE_GRANT_REVISION) continue;
    const added: string[] = [];
    const nextRoles: Json = { ...roles };
    for (const [role, definition] of Object.entries(roles)) {
      if (!granted.has(role) || !isObject(definition)) continue;
      const features = Array.isArray(definition.grantedFeatures) ? definition.grantedFeatures : [];
      if (features.includes('*') || features.includes(DEVICE_OWN_FEATURE)) continue;
      nextRoles[role] = { ...definition, grantedFeatures: [...features, DEVICE_OWN_FEATURE] };
      added.push(role);
    }
    rows.push({
      file: relative(ctx.home, path),
      next: { ...record, roles: nextRoles, roleGrantVersion: ROLE_GRANT_REVISION, formatVersion: PROJECT_UPGRADE_STEPS.device.to },
      roles: added,
    });
  }
  return rows;
}

/** The operator device a first run already registered (a resumed run keeps its owner and epoch), or null. */
async function registeredOwner(ctx: OfflineUpgradeContext, secret: string): Promise<{ ownerUserId: string; pairedEpoch: number } | null> {
  try {
    const record = JSON.parse(await readFile(join(deviceRegistryRoot(ctx.appRoot), 'devices', `${operatorDeviceId(secret)}.json`), 'utf8')) as Json;
    return typeof record.ownerUserId === 'string' && typeof record.pairedEpoch === 'number' ? { ownerUserId: record.ownerUserId, pairedEpoch: record.pairedEpoch } : null;
  } catch {
    return null;
  }
}

type Plan = {
  census: SourceDeviceCensus;
  operator: OperatorDeviceInput | null;
  /** The operator device is new this run (a resumed run finds it registered). */
  registering: boolean;
  identity: { file: string; write: boolean } | null;
  grants: GrantRow[];
  summary: string[];
  blockers: string[];
};

async function plan(ctx: OfflineUpgradeContext, env: Readonly<Record<string, string | undefined>>): Promise<Plan> {
  const census = await inspectSourceDevice(ctx);
  const grants = await inspectGrants(ctx);
  const configs = census.configs.filter((row) => !row.device);
  const metas = census.metas.filter((row) => !row.device);
  const needsDevice = configs.length + metas.length > 0;
  const named = env[DEVICE_OWNER_ENV]?.trim();
  const found = await readOperatorSecret(ctx.home);
  const summary: string[] = [
    `host sources: ${census.configs.length} (${configs.length} to stamp) · host shells: ${census.metas.length} (${metas.length} to stamp; ${census.walked} folder(s) walked)`,
    `role grants: ${grants.length} project(s) raised to revision ${ROLE_GRANT_REVISION}, ${grants.filter((g) => g.roles.length > 0).length} gaining ${DEVICE_OWN_FEATURE}`,
  ];
  const blockers: string[] = [];
  let operator: OperatorDeviceInput | null = null;
  let registering = false;
  let identity: Plan['identity'] = null;

  if (!found) {
    for (const row of configs) blockers.push(`${row.projectId} · host source · ${row.file} · connection.config.device · no operator device: no broker secret under ${ctx.home}/host-broker/ or ${ctx.home}/device/`);
    for (const row of metas) blockers.push(`${row.projectId} · host shell · ${row.file} · device · no operator device: no broker secret`);
    summary.push('operator device: none (no broker secret on this machine)');
  } else if (!needsDevice && !named && !(await registeredOwner(ctx, found.secret))) {
    summary.push(`operator device: not registered — no host source names it (pair the server with \`neuralis device pair\`, or set ${DEVICE_OWNER_ENV}=<userId> and run this again to keep its secret)`);
  } else {
    let ownerId: string | null = null;
    let owner: Json | null = null;
    const registered = await registeredOwner(ctx, found.secret);
    registering = !registered;
    if (registered) {
      // A resumed run: the device was registered by the first one — its owner and epoch stand.
      ownerId = registered.ownerUserId;
      owner = { sessionEpoch: registered.pairedEpoch };
    } else if (named) {
      owner = await realUser(ctx.appRoot, named);
      if (owner) ownerId = named;
      else blockers.push(`operator device · ${DEVICE_OWNER_ENV}=${named} · owner · names no user of this install`);
    } else {
      const candidates = [...new Set(configs.flatMap((row) => row.users))].sort();
      const users: string[] = [];
      for (const id of candidates) if (await realUser(ctx.appRoot, id)) users.push(id);
      if (users.length === 1) {
        ownerId = users[0]!;
        owner = await realUser(ctx.appRoot, ownerId);
      } else {
        blockers.push(`operator device · owner · the host sources name ${users.length === 0 ? 'no user of this install' : `${users.length} users (${users.join(', ')})`}${candidates.includes(OPERATOR_LITERAL) ? ` and the \`${OPERATOR_LITERAL}\` literal, which is never an owner` : ''} — say who owns the server with ${DEVICE_OWNER_ENV}=<userId>`);
      }
    }
    if (found.secret.length < 32) blockers.push(`operator device · ${relative(ctx.home, found.file)} · secret · shorter than 32 characters — the broker never accepted it either`);
    if (ownerId && owner && found.secret.length >= 32) {
      operator = {
        secret: found.secret,
        ownerUserId: ownerId,
        pairedEpoch: sessionEpochOf(owner as { sessionEpoch?: number }),
        name: DEVICE_NAME,
        claims: { platform: process.platform, arch: process.arch, brokerVersion: 0 },
      };
      const id = operatorDeviceId(found.secret);
      const file = deviceIdentityFile(ctx.home);
      let write = true;
      if (existsSync(file)) {
        const current = JSON.parse(await readFile(file, 'utf8')) as { deviceId?: unknown };
        if (current.deviceId === id) write = false;
        else blockers.push(`operator device · ${relative(ctx.home, file)} · deviceId · names another device (${String(current.deviceId)}) — move it aside, or pair the server again instead`);
      }
      identity = { file, write };
      summary.push(`operator device: ${id}, owned by ${ownerId}${write ? ` — ${relative(ctx.home, file)} written for \`neuralis device install\`` : ''}`);
    }
  }
  return { census, operator, registering, identity, grants, summary, blockers };
}

function asPlan(p: Plan, ctx: OfflineUpgradeContext): OfflineUpgradePlan {
  const files = [
    ...p.census.configs.filter((row) => !row.device).map((row) => row.file),
    ...p.census.metas.filter((row) => !row.device).map((row) => row.file),
    ...p.grants.map((row) => row.file),
    ...(p.operator && p.registering ? [relative(ctx.home, join(deviceRegistryRoot(ctx.appRoot), 'devices'))] : []),
    ...(p.identity?.write ? [relative(ctx.home, p.identity.file)] : []),
  ];
  return { files, summary: p.summary, ...(p.blockers.length > 0 ? { blockers: { lines: p.blockers, remedy: REMEDY } } : {}) };
}

export function createSourceDeviceUpgrade(env: Readonly<Record<string, string | undefined>> = process.env): OfflineUpgradeModule {
  return {
    id: PROJECT_UPGRADE_STEPS.device.id,
    kinds: [
      ...SOURCE_DEVICE_AGENT_CORE_KINDS,
      { kind: HOST_DATA_FORMATS.project.kind, to: PROJECT_UPGRADE_STEPS.device.to },
    ],
    dryRun: async (ctx) => asPlan(await plan(ctx, env), ctx),
    async apply(ctx) {
      const p = await plan(ctx, env);
      if (p.blockers.length > 0) throw new Error(`source-device-v1: ${p.blockers.join('; ')} — ${REMEDY}`);
      const done = await applySourceDevice(ctx, p.operator);
      if (p.operator && p.identity?.write) {
        await mkdir(join(ctx.home, 'device'), { recursive: true, mode: 0o700 });
        await durableReplaceFile(p.identity.file, `${JSON.stringify(operatorIdentity(operatorDeviceId(p.operator.secret), env), null, 2)}\n`, { mode: 0o600 });
      }
      for (const row of p.grants) await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      ctx.log(`source-device-v1: ${done.registered ? 'operator device registered, ' : ''}${done.configs} host source(s) and ${done.metas} host shell(s) stamped, ${p.grants.length} project(s) raised`);
    },
  };
}

export default createSourceDeviceUpgrade() satisfies OfflineUpgradeModule;

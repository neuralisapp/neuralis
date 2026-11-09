/**
 * The runtime package install — a native package installed, updated or
 * removed while the host runs, and active from its next start (the way Claude
 * Code and Codex apply a plugin at the next session). One transaction on every
 * host kind: the desktop app's native host and a Docker host alike keep the
 * record in the app data folder (`<appRoot>/packages/`, which survives an image
 * rebuild), beside the packages the image itself ships.
 *
 *   <appRoot>/packages/package.json       THE RECORD — its `dependencies` are
 *                                         the installed packages, exact
 *                                         versions (`file:tarballs/…` for an
 *                                         uploaded one); discovery reads it
 *                                         (`builtinSlots.ts`)
 *   <appRoot>/packages/package-lock.json  written by npm at the first install,
 *                                         the install's authority after it
 *   <appRoot>/packages/node_modules/      npm's tree + the peer links
 *   <appRoot>/packages/tarballs/          uploaded tarballs the record names
 *   <appRoot>/package-requests/<id>/      a pending ask: request.json (+ the
 *                                         staged package.tgz)
 *
 * Writing the record is the admin trust act a `neuralis pkg add` is in the
 * image lane: what it lists loads in-process with native trust. So every
 * member re-derives its caller's features FRESH — `platform.packages` to list,
 * ask and dismiss, `platform.packages.approve` as well to approve and restart
 * (a person, an agent or the CLI alike: the feature is the authority, the call
 * provenance only labels the audit row) — and the record changes ONLY in
 * `approve`. `request` stages and summarizes without running any of the
 * package's code: a registry name is fetched with `npm pack` (one tarball, no
 * dependency), an uploaded tarball is written as sent; both are read through
 * `tar` to stdout, never unpacked. Refused before anything is kept: a name the
 * operator's allow-list (`<appRoot>/packages/allow-list.json`) leaves out and a
 * recorded private scope (both before any network step), a name the host
 * itself ships (the image's copy wins), a package without a `neuralis` block,
 * one that lists a shared platform package as its own dependency or needs a
 * peer the host lacks, and one in conflict with a loaded builtin (a contract,
 * an OAuth prefix, a config key). `approve` runs npm in the record, then
 * checks the bytes — an uploaded tarball's staged copy against the approved
 * sha512 before npm runs, the lock's integrity after it (a registry install
 * whose lock carries none fails closed) — then what npm installed: no own copy
 * of a shared peer in the lock, the runtime's own admission check; and
 * restores the record on any refusal. A registry request also asks the
 * registry whether this exact version carries an npm provenance attestation
 * (`npm view <name>@<version> dist --json`) and the summary says so; none is
 * shown as "no verified build source", never refused.
 *
 * Cost: `list` = the record, its lock, one manifest per installed package and
 * the request folder (the host's own rows come from boot memory); `request` =
 * one npm child to fetch and one to read the attestation (registry, ≈ 1–3 s
 * each) or one base64 decode, two `tar` children, one manifest parse, the
 * allow-list file; `approve` = one npm child (two when it rolls back), one
 * metadata-only validation (one manifest read and one directory walk), one
 * lock parse. Nothing runs between calls.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { findBuiltinSetConflicts } from '@neuralis/package-system';
import { providedFeatureIds } from '@neuralis/package-system/contracts';
import type { HostPorts, PackageDefinition, SessionContext } from '@neuralis/package-system/contracts';
import { assignBuiltinProvenance, selectBuiltinPackageIds, type DepManifest } from '../../host/builtinSlots';
import type { AuditAction } from '../../store/AuditStore';
import { defaultGrantedFeatures, recordBuiltinAddition, recordBuiltinRemoval } from '../builtinGrantChangesRecord';
import { linkSharedPeers, sharedPeers, unlinkSharedPeers } from './peerLinks';
import {
  npmFailureText,
  readRecordedPrivateScopes,
  sha512Integrity,
  tarballEntries,
  tarballText,
  type NpmRunner,
} from './npm';

// The kernel's port vocabulary (`contracts/hostPorts.ts`), reached through `HostPorts`.
export type PlatformPackagesPort = NonNullable<HostPorts['platformPackages']>;
export type PlatformPackagesView = Awaited<ReturnType<PlatformPackagesPort['list']>>;
export type PlatformPackageRow = PlatformPackagesView['installed'][number];
export type PlatformPackageRequest = PlatformPackagesView['requests'][number];
export type PlatformPackageSummary = PlatformPackageRequest['summary'];
export type PlatformPackageProvenance = Parameters<PlatformPackagesPort['approve']>[2];
/** What a caller needs: `ask` (list, request, dismiss) or `approve` (approve, restart). */
export type PlatformPackageNeed = 'ask' | 'approve';

/** Pending asks at once — a resource bound on the staging folder, not a tunable. */
export const MAX_PENDING_REQUESTS = 10;
/** A pending ask expires after a day. */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export const PLATFORM_PACKAGES_FEATURE = 'platform.packages';
export const PLATFORM_PACKAGES_APPROVE_FEATURE = 'platform.packages.approve';
export const REQUESTS_DIR = 'package-requests';
/** The operator's allow-list, beside the record: scopes (`@acme`) or exact names. Missing or empty = every name. */
export const ALLOW_LIST_FILE = 'allow-list.json';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_RANGE = /^[0-9A-Za-z.^~<>=|* +-]{1,64}$/;

/** A refusal with the HTTP status and a stable code the route answers with. */
export class PlatformPackageError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformPackageError';
  }
}

/** What this lane writes to the audit trail — members of `AuditAction`, so an unlisted tag does not compile. */
export type PlatformPackageAuditAction = Extract<AuditAction, 'package.install' | 'package.update' | 'package.uninstall' | 'package.request' | 'package.request_dismissed' | 'package.restart'>;

export type PlatformPackagesDeps = {
  appRoot: string;
  /** NEURALIS_HOME — the private-scope record lives under `<home>/build`. */
  home: string;
  /** This process's builtin ids, the record entries it loaded and the record's lines as it started. */
  activeIds: ReadonlySet<string>;
  runtimeInstalledAtBoot: ReadonlySet<string>;
  bootRecordLines: Readonly<Record<string, string>>;
  /** The host's own dependency names (an image copy wins over the record, by name). */
  hostLines: ReadonlySet<string>;
  /** The host's own installation as rows (`slot: 'image'`), from boot memory. */
  imageRows: () => readonly PlatformPackageRow[];
  /** Why this start left a builtin out, when it did (`disabled` or a refusal). */
  refusedAtBoot: (id: string) => 'disabled' | 'refused' | undefined;
  /** The builtin manifests this boot read (trust stamped), for the set-conflict check. */
  builtinDefinitions: () => readonly PackageDefinition[];
  /** Who declared a config key (`PlatformConfigStore.getRegisteredSetting`). */
  configKeyOwner: (key: string) => string | undefined;
  /** The host's root of a dependency; throws when the host has none. */
  resolveHostPeer: (name: string) => string;
  /** The runtime provider's admission check (metadata-only). */
  validate: (packageRoot: string) => Promise<{ errors: string[] }>;
  registryUrl: () => string;
  timeoutMs: () => number;
  uploadMaxBytes: () => number;
  /** null: this Node ships no npm. */
  npm: NpmRunner | null;
  /** Throws a 403 unless the caller holds what `need` asks for right now (`platform.packages`, and for `approve` `platform.packages.approve` too). */
  authorize: (caller: SessionContext, need: PlatformPackageNeed) => Promise<void>;
  audit: (event: { action: PlatformPackageAuditAction; userId: string; target?: string; details?: Record<string, unknown> }) => void;
  /** The host log: npm's own output lands here, never in an answer (its lines name host paths). */
  log: (message: string, meta: Record<string, unknown>) => void;
  restartMode: PlatformPackagesView['restart'];
  stopForRestart: () => void;
  now?: () => Date;
  newId?: () => string;
  tar?: { entries: (tgz: string) => string[] | null; text: (tgz: string, member: string) => string | null };
};

type RecordFile = { name?: string; private?: boolean; description?: string; dependencies?: Record<string, string> };
type LockFile = { packages?: Record<string, { version?: string; integrity?: string; resolved?: string }> };

type StoredRequest = PlatformPackageRequest & { spec?: string; artifact?: string };

/** The audit and request label of a call: a person, an agent (named) or a signed-in client. */
function callerOf(caller: SessionContext, via: PlatformPackageProvenance): { via: PlatformPackageRequest['via']; agent?: { id: string; projectId: string } } {
  if (via.interactive) return { via: 'person' };
  if (via.agentId) return { via: 'agent', agent: { id: via.agentId, projectId: caller.projectId } };
  return { via: 'cli' };
}

/** The audit details of a call's provenance (`agentId` only for an agent). */
function auditVia(label: ReturnType<typeof callerOf>): Record<string, unknown> {
  return label.agent ? { via: label.via, agentId: label.agent.id } : { via: label.via };
}

/** An allow-list entry admits a scope (`@acme`) or one exact name. */
export function allowListAdmits(entries: readonly string[], name: string): boolean {
  return entries.length === 0 || entries.some((entry) => entry === name || (!entry.includes('/') && entry.startsWith('@') && name.startsWith(`${entry}/`)));
}

type NpmPackManifest = DepManifest & {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const RECORD_SEED: RecordFile = {
  name: 'neuralis-platform-packages',
  private: true,
  description: 'Packages installed into this Neuralis host while it runs. The host writes this file; edit it only through the host.',
  dependencies: {},
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (text.length < 3) throw new Error('refusing to write an empty record');
  await writeFile(`${path}.tmp`, text, 'utf-8');
  await rename(`${path}.tmp`, path);
}

function sameLines(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** `name` or `name@range` — a registry name only: never a URL, a git ref, a path or an alias. */
export function parseRegistrySpec(spec: string): { name: string; range: string } | null {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf('@');
  const [name, range] = at > 0 ? [trimmed.slice(0, at), trimmed.slice(at + 1)] : [trimmed, 'latest'];
  if (!NPM_NAME.test(name) || name.length > 214 || !NPM_RANGE.test(range)) return null;
  return { name, range };
}

export function createPlatformPackages(deps: PlatformPackagesDeps): PlatformPackagesPort {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const tar = deps.tar ?? { entries: (tgz: string) => tarballEntries(tgz), text: (tgz: string, member: string) => tarballText(tgz, member) };
  const root = join(deps.appRoot, 'packages');
  const requestsRoot = join(deps.appRoot, REQUESTS_DIR);
  const recordPath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  // One mutation at a time: every record/stage write rides this chain.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const readRecord = async (): Promise<RecordFile> => (await readJson<RecordFile>(recordPath)) ?? { ...RECORD_SEED, dependencies: {} };
  const installedManifest = (id: string): Promise<NpmPackManifest | null> => readJson<NpmPackManifest>(join(root, 'node_modules', id, 'package.json'));

  const requireNpm = (): NpmRunner => {
    if (!deps.npm) throw new PlatformPackageError(503, 'npm_unavailable', 'This host\'s Node.js ships no npm, so it cannot install packages while it runs.');
    return deps.npm;
  };

  const refusePrivateScopes = async (): Promise<void> => {
    let scopes: string[];
    try {
      scopes = await readRecordedPrivateScopes(deps.home);
    } catch (err) {
      throw new PlatformPackageError(409, 'private_scope_record_unreadable', `${err instanceof Error ? err.message : String(err)} — fix or delete it before installing.`);
    }
    if (scopes.length > 0) {
      throw new PlatformPackageError(409, 'private_scope_recorded',
        `This machine has installed packages of ${scopes.join(', ')} from a private registry; a package installed while the host runs never asks the public registry while one is recorded. Register it with \`neuralis pkg add\` and rebuild, or delete the entry from build/private-scopes.json in the data folder if the scope is public now.`);
    }
  };

  /**
   * The operator's allow-list (a JSON array of scopes and exact names, written
   * on the machine — no route or setting writes it), checked before any network
   * step. Missing or empty admits every name; a file that is no such list
   * refuses every install until it is fixed — it was written to restrict.
   */
  const refuseUnlisted = async (name: string): Promise<void> => {
    let text: string;
    try {
      text = await readFile(join(root, ALLOW_LIST_FILE), 'utf-8');
    } catch {
      return;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(text);
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries) || !entries.every((e) => typeof e === 'string')) {
      throw new PlatformPackageError(409, 'allow_list_unreadable', `packages/${ALLOW_LIST_FILE} in the data folder is no JSON list of scopes and package names — fix or delete it before installing.`);
    }
    if (!allowListAdmits(entries as string[], name)) {
      throw new PlatformPackageError(403, 'not_allowed', `${name} is not on this host's allow-list (packages/${ALLOW_LIST_FILE} in the data folder); the machine's operator adds a scope or the name there.`);
    }
  };

  /** Whether the registry holds an npm provenance attestation for this exact version (one `npm view`); anything else reads as none. */
  const provenanceOf = async (npm: NpmRunner, registry: string, cwd: string, id: string, version: string): Promise<'attested' | 'none'> => {
    const run = await npm(['view', `${id}@${version}`, 'dist', '--json'], { cwd, registry, timeoutMs: deps.timeoutMs() }).catch(() => null);
    if (!run || run.code !== 0) return 'none';
    try {
      const dist = JSON.parse(run.stdout) as { attestations?: { provenance?: unknown } } | null;
      return dist?.attestations?.provenance ? 'attested' : 'none';
    } catch {
      return 'none';
    }
  };

  const listRequests = async (): Promise<StoredRequest[]> => {
    let names: string[];
    try {
      names = await readdir(requestsRoot);
    } catch {
      return [];
    }
    const cutoff = now().getTime() - REQUEST_TTL_MS;
    const out: StoredRequest[] = [];
    for (const name of names.filter((n) => REQUEST_ID.test(n)).sort()) {
      const stored = await readJson<StoredRequest>(join(requestsRoot, name, 'request.json'));
      if (stored && stored.id === name && Date.parse(stored.requestedAt) >= cutoff) out.push(stored);
    }
    return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  };

  const pruneExpired = async (): Promise<void> => {
    const live = new Set((await listRequests()).map((r) => r.id));
    let names: string[] = [];
    try {
      names = await readdir(requestsRoot);
    } catch {
      return;
    }
    for (const name of names) if (REQUEST_ID.test(name) && !live.has(name)) await rm(join(requestsRoot, name), { recursive: true, force: true });
  };

  const publicRequest = (stored: StoredRequest): PlatformPackageRequest => ({
    id: stored.id, action: stored.action, summary: stored.summary, requestedBy: stored.requestedBy,
    via: stored.via, ...(stored.agent ? { agent: stored.agent } : {}), requestedAt: stored.requestedAt,
  });

  /**
   * The platform packages a dependency of the candidate must never duplicate.
   * The candidate itself is never one of them: an UPDATE replaces an active
   * package, and `node_modules/<id>` in the lock is the package, not a copy.
   */
  const sharedNames = async (candidateId: string, candidatePeers: readonly string[]): Promise<Set<string>> => {
    const shared = new Set<string>([...deps.activeIds, ...[...deps.hostLines].filter((n) => n.startsWith('@neuralis/'))]);
    const declared = new Set(candidatePeers);
    const record = await readRecord();
    for (const id of Object.keys(record.dependencies ?? {})) {
      for (const peer of Object.keys((await installedManifest(id))?.peerDependencies ?? {})) declared.add(peer);
    }
    for (const peer of declared) if (deps.hostLines.has(peer)) shared.add(peer);
    shared.delete(candidateId);
    return shared;
  };

  /** Judge a staged tarball and build what the approval screen shows. Throws on every refusal. */
  const judge = async (tgz: string, source: PlatformPackageSummary['source']): Promise<{ summary: PlatformPackageSummary; manifest: NpmPackManifest }> => {
    const entries = tar.entries(tgz);
    const top = entries?.[0]?.split('/')[0];
    const text = top ? tar.text(tgz, `${top}/package.json`) : null;
    let manifest: NpmPackManifest | null = null;
    try {
      manifest = text ? (JSON.parse(text) as NpmPackManifest) : null;
    } catch {
      manifest = null;
    }
    if (!entries || !top || !manifest) throw new PlatformPackageError(422, 'not_a_package', 'The tarball holds no readable package.json.');
    const id = typeof manifest.name === 'string' ? manifest.name : '';
    const version = typeof manifest.version === 'string' ? manifest.version : '';
    if (!NPM_NAME.test(id) || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new PlatformPackageError(422, 'not_a_package', 'The package.json names no valid "name" and "version".');
    if (selectBuiltinPackageIds({ [id]: version }, () => manifest!).length !== 1) {
      throw new PlatformPackageError(422, 'not_a_package', `${id} carries no "neuralis" block (or is reference-only), so it is no Neuralis package.`);
    }
    if (deps.hostLines.has(id)) {
      throw new PlatformPackageError(409, 'shipped_with_host', `${id} is part of this host's own installation; that copy is the one that loads.`);
    }
    await refuseUnlisted(id);
    const block = manifest.neuralis as Partial<PackageDefinition>;
    const peers = Object.keys(manifest.peerDependencies ?? {}).sort();
    const own = Object.keys(manifest.dependencies ?? {}).sort();
    if (own.includes(id)) {
      throw new PlatformPackageError(422, 'brings_own_peer', `${id} lists itself as its own dependency.`);
    }
    const shared = await sharedNames(id, peers);
    const duplicated = own.filter((d) => shared.has(d));
    if (duplicated.length > 0) {
      throw new PlatformPackageError(422, 'brings_own_peer', `${id} lists ${duplicated.join(', ')} as its own dependency; a platform package is shared — declare it in peerDependencies.`);
    }
    const missing = peers.filter((p) => manifest!.peerDependenciesMeta?.[p]?.optional !== true).filter((p) => {
      try {
        deps.resolveHostPeer(p);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) throw new PlatformPackageError(422, 'peer_unavailable', `${id} needs ${missing.join(', ')}, which this host does not have.`);

    const candidate = assignBuiltinProvenance({ ...block, id, name: id } as PackageDefinition);
    const others = deps.builtinDefinitions().filter((d) => d.id !== id);
    const conflicts = findBuiltinSetConflicts([...others, candidate]).filter((c) => c.packages.includes(id));
    const ownedKeys = (block.configSettings ?? [])
      .map((s) => ({ key: s.key, owner: deps.configKeyOwner(s.key) }))
      .filter((k) => k.owner !== undefined && k.owner !== id && !others.some((d) => d.id === k.owner));
    if (conflicts.length > 0 || ownedKeys.length > 0) {
      const reasons = [...conflicts.map((c) => c.message), ...ownedKeys.map((k) => `config key "${k.key}" belongs to ${k.owner}`)];
      throw new PlatformPackageError(409, 'conflict', `${id} cannot load beside this host's packages: ${reasons.join('; ')}.`);
    }

    const under = (prefix: string, suffix: string): string[] =>
      entries.filter((e) => e.startsWith(`${top}/${prefix}`) && e.endsWith(suffix))
        .map((e) => e.slice(`${top}/${prefix}`.length, -suffix.length))
        .filter((name) => name.length > 0 && !name.includes('/'))
        .sort();
    const replaces = (await installedManifest(id))?.version;
    const summary: PlatformPackageSummary = {
      id,
      version,
      integrity: await sha512Integrity(tgz),
      source,
      ...(typeof replaces === 'string' && (await readRecord()).dependencies?.[id] ? { replaces } : {}),
      ...(typeof manifest.description === 'string' ? { description: manifest.description.slice(0, 300) } : {}),
      routes: under('dist/src/routes/', '.js'),
      tools: under('tools/', '.json'),
      features: providedFeatureIds(block.requires?.providesFeatures).sort(),
      defaultRoleGrants: block.requires?.defaultRoleGrants ?? {},
      configKeys: (block.configSettings ?? []).map((s) => s.key).sort(),
      credentials: (block.credentials ?? []).map((c) => c.id).sort(),
      connectors: (block.connectors ?? []).map((c) => (c as { kind?: string; id?: string }).kind ?? (c as { id?: string }).id ?? '?').sort(),
      sources: (block.sources ?? []).map((s) => (s as { slug?: string }).slug ?? '?').sort(),
      skills: entries.filter((e) => /^[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(e)).length,
      surfaces: block.app?.surfaces?.length ?? 0,
      peers,
      dependencies: own,
    };
    return { summary, manifest };
  };

  const stage = async (caller: SessionContext, label: ReturnType<typeof callerOf>, fill: (dir: string) => Promise<{ tgz: string; spec?: string; source: PlatformPackageSummary['source']; registry?: string }>): Promise<PlatformPackageRequest> => {
    await pruneExpired();
    if ((await listRequests()).length >= MAX_PENDING_REQUESTS) {
      throw new PlatformPackageError(429, 'too_many_requests', `${MAX_PENDING_REQUESTS} requests are already waiting — approve or dismiss one first.`);
    }
    const id = newId();
    const dir = join(requestsRoot, id);
    await mkdir(dir, { recursive: true });
    try {
      const { tgz, spec, source, registry } = await fill(dir);
      const judged = await judge(tgz, source);
      // Which registry served the bytes: the approver reads it, since a config holder can repoint it.
      const provenance = registry ? await provenanceOf(requireNpm(), registry, dir, judged.summary.id, judged.summary.version) : 'none';
      const summary: PlatformPackageSummary = registry ? { ...judged.summary, registry, provenance } : { ...judged.summary, provenance };
      const stored: StoredRequest = {
        id, action: 'install', summary, requestedBy: caller.userId, ...label, requestedAt: now().toISOString(),
        artifact: 'package.tgz', ...(spec ? { spec: `${summary.id}@${summary.version}` } : {}),
      };
      if (tgz !== join(dir, 'package.tgz')) await rename(tgz, join(dir, 'package.tgz'));
      await writeJson(join(dir, 'request.json'), stored);
      deps.audit({ action: 'package.request', userId: caller.userId, target: summary.id, details: { version: summary.version, integrity: summary.integrity, source, provenance, requestId: id, ...auditVia(label) } });
      return publicRequest(stored);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  };

  const install = async (caller: SessionContext, stored: StoredRequest, label: ReturnType<typeof callerOf>): Promise<{ packageId: string; version: string }> => {
    const npm = requireNpm();
    const { summary } = stored;
    // A registry ask fetches again at approval: from another registry the bytes would fail the
    // integrity proof below, so the change is named for what it is, before npm runs.
    if (summary.source === 'registry' && summary.registry !== undefined && summary.registry !== deps.registryUrl()) {
      throw new PlatformPackageError(409, 'registry_changed', `The package registry changed since ${summary.id} was asked for (${summary.registry} → ${deps.registryUrl()}). Ask again to review it from the current registry.`);
    }
    // The allow-list may have changed since the ask: judged again before npm touches a network.
    await refuseUnlisted(summary.id);
    await refusePrivateScopes();
    // The request's copy IS the bytes npm installs from: proved the approved tarball before anything
    // is written — a re-install of the same id@version never overwrites the recorded file with others.
    if (summary.source === 'tarball' && await sha512Integrity(join(requestsRoot, stored.id, 'package.tgz')) !== summary.integrity) {
      throw new PlatformPackageError(409, 'integrity_mismatch', `The staged tarball of ${summary.id}@${summary.version} is not the approved one.`);
    }
    const before = { record: await readFile(recordPath, 'utf-8').catch(() => null), lock: await readFile(lockPath, 'utf-8').catch(() => null) };
    await mkdir(root, { recursive: true });
    if (before.record === null) await writeJson(recordPath, RECORD_SEED);
    let target = stored.spec;
    let addedTarball: string | null = null;
    if (summary.source === 'tarball') {
      await mkdir(join(root, 'tarballs'), { recursive: true });
      // npm's own tarball name (`<scope>-<name>-<version>.tgz`): the name and version charsets are judged at request.
      const file = `${summary.id.replace(/^@/, '').replace('/', '-')}-${summary.version}.tgz`;
      const existed = await stat(join(root, 'tarballs', file)).then(() => true, () => false);
      await copyFile(join(requestsRoot, stored.id, 'package.tgz'), join(root, 'tarballs', file));
      if (!existed) addedTarball = join(root, 'tarballs', file);
      target = `./tarballs/${file}`;
    }
    if (!target) throw new PlatformPackageError(409, 'request_unusable', 'The request names nothing to install.');

    const peersBefore = sharedPeers(root, Object.keys((await readRecord()).dependencies ?? {}), deps.resolveHostPeer);
    unlinkSharedPeers(root, peersBefore.keys());
    const rollback = async (code: string, status: number, message: string): Promise<never> => {
      if (before.record === null) await rm(recordPath, { force: true });
      else await writeFile(recordPath, before.record, 'utf-8');
      if (before.lock === null) await rm(lockPath, { force: true });
      else await writeFile(lockPath, before.lock, 'utf-8');
      if (addedTarball) await rm(addedTarball, { force: true });
      // Converge the tree on the restored record (best effort — the record, not the tree, is what loads).
      await npm(['install', '--no-save'], { cwd: root, registry: deps.registryUrl(), timeoutMs: deps.timeoutMs() }).catch(() => undefined);
      linkSharedPeers(root, sharedPeers(root, Object.keys((await readRecord()).dependencies ?? {}), deps.resolveHostPeer));
      throw new PlatformPackageError(status, code, message);
    };

    const run = await npm(['install', target, '--save-exact'], { cwd: root, registry: deps.registryUrl(), timeoutMs: deps.timeoutMs() });
    if (run.code !== 0) {
      deps.log('npm install failed', { packageId: summary.id, output: npmFailureText(run) });
      return rollback('npm_failed', 502, `npm could not install ${summary.id}. The host log has npm's output.`);
    }
    const installed = await installedManifest(summary.id);
    if (!installed || installed.name !== summary.id || installed.version !== summary.version) {
      return rollback('integrity_mismatch', 409, `npm installed ${String(installed?.version ?? 'nothing')} of ${summary.id}, not the approved ${summary.version}.`);
    }
    const lock = await readJson<LockFile>(lockPath);
    const lockIntegrity = lock?.packages?.[`node_modules/${summary.id}`]?.integrity;
    // A registry install fetched the bytes again just now: without the lock's
    // integrity nothing proves they are the approved ones, so it fails closed.
    if (summary.source === 'registry' && lockIntegrity === undefined) {
      return rollback('integrity_unverifiable', 409, `npm recorded no integrity for ${summary.id}@${summary.version}, so the installed bytes cannot be matched to the approved ones.`);
    }
    if (lockIntegrity !== undefined && lockIntegrity !== summary.integrity) {
      return rollback('integrity_mismatch', 409, `The registry served ${summary.id}@${summary.version} with other bytes than the approved ones.`);
    }
    const shared = await sharedNames(summary.id, summary.peers);
    const copies = Object.keys(lock?.packages ?? {}).filter((path) => [...shared].some((name) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)));
    if (copies.length > 0) return rollback('brings_own_peer', 422, `${summary.id} brings its own copy of a shared platform package (${copies.join(', ')}).`);
    linkSharedPeers(root, sharedPeers(root, Object.keys((await readRecord()).dependencies ?? {}), deps.resolveHostPeer));
    const verdict = await deps.validate(join(root, 'node_modules', summary.id));
    if (verdict.errors.length > 0) return rollback('refused_by_validator', 422, `The runtime would refuse ${summary.id}: ${verdict.errors.slice(0, 5).join('; ')}`);
    // The next start finds it exactly as discovery will: `<id>/package.json` through the record's own resolver.
    try {
      createRequire(recordPath).resolve(`${summary.id}/package.json`);
    } catch {
      return rollback('not_discoverable', 422, `${summary.id}'s "exports" hide its package.json, so the host could not find it at the next start.`);
    }

    await recordBuiltinAddition(deps.appRoot, summary.id, now());
    deps.audit({
      action: summary.replaces ? 'package.update' : 'package.install',
      userId: caller.userId,
      target: summary.id,
      details: { version: summary.version, integrity: summary.integrity, source: summary.source, ...(summary.replaces ? { replaces: summary.replaces } : {}), npmMs: run.ms, requestId: stored.id, ...auditVia(label) },
    });
    return { packageId: summary.id, version: summary.version };
  };

  const remove = async (caller: SessionContext, stored: StoredRequest, label: ReturnType<typeof callerOf>): Promise<{ packageId: string; version: string }> => {
    const record = await readRecord();
    const id = stored.summary.id;
    if (!record.dependencies?.[id]) throw new PlatformPackageError(404, 'not_installed', `${id} is not installed here.`);
    const manifest = await installedManifest(id);
    const { [id]: spec, ...rest } = record.dependencies;
    await writeJson(recordPath, { ...record, dependencies: rest });
    // An uploaded tarball goes with its line; the installed files stay until npm's next run in the record, after the restart.
    const tarball = spec?.match(/^file:(?:\.\/)?tarballs\/([A-Za-z0-9._-]+\.tgz)$/)?.[1];
    if (tarball) await rm(join(root, 'tarballs', tarball), { force: true });
    await recordBuiltinRemoval(deps.appRoot, id, defaultGrantedFeatures((manifest?.neuralis as Partial<PackageDefinition> | undefined)?.requires), now());
    deps.audit({ action: 'package.uninstall', userId: caller.userId, target: id, details: { version: stored.summary.version, requestId: stored.id, ...auditVia(label) } });
    return { packageId: id, version: stored.summary.version };
  };

  return {
    async list(caller) {
      await deps.authorize(caller, 'ask');
      const record = await readRecord();
      const lock = await readJson<LockFile>(lockPath);
      const lines = record.dependencies ?? {};
      const installed: PlatformPackageRow[] = [...deps.imageRows()];
      for (const [id, spec] of Object.entries(lines)) {
        const manifest = await installedManifest(id);
        const asStarted = deps.runtimeInstalledAtBoot.has(id) && deps.bootRecordLines[id] === spec;
        const refused = asStarted ? deps.refusedAtBoot(id) : undefined;
        installed.push({
          id,
          version: typeof manifest?.version === 'string' ? manifest.version : spec,
          slot: 'runtime',
          status: refused ?? (asStarted ? 'loaded' : 'restart'),
          optional: false,
          source: spec.startsWith('file:') ? 'tarball' : 'registry',
          integrity: lock?.packages?.[`node_modules/${id}`]?.integrity ?? null,
        });
      }
      installed.sort((a, b) => a.id.localeCompare(b.id));
      return {
        installed,
        requests: (await listRequests()).map(publicRequest),
        restartRequired: !sameLines(lines, deps.bootRecordLines),
        restart: deps.restartMode,
      };
    },

    request(caller, ask, via) {
      return serial(async () => {
        await deps.authorize(caller, 'ask');
        const label = callerOf(caller, via);
        if ('remove' in ask) {
          const id = typeof ask.remove === 'string' ? ask.remove.trim() : '';
          const record = await readRecord();
          const spec = record.dependencies?.[id];
          if (!spec) throw new PlatformPackageError(404, 'not_installed', `${id || 'That package'} is not installed here${deps.hostLines.has(id) ? ' — it is part of the host\'s own installation' : ''}.`);
          const manifest = await installedManifest(id);
          const block = (manifest?.neuralis ?? {}) as Partial<PackageDefinition>;
          await pruneExpired();
          const reqId = newId();
          const summary: PlatformPackageSummary = {
            id, version: typeof manifest?.version === 'string' ? manifest.version : spec, integrity: '', source: spec.startsWith('file:') ? 'tarball' : 'registry',
            routes: [], tools: [], features: providedFeatureIds(block.requires?.providesFeatures).sort(),
            defaultRoleGrants: block.requires?.defaultRoleGrants ?? {}, configKeys: (block.configSettings ?? []).map((s) => s.key).sort(),
            credentials: [], connectors: [], sources: [], skills: 0, surfaces: 0, peers: [], dependencies: [],
          };
          const stored: StoredRequest = { id: reqId, action: 'remove', summary, requestedBy: caller.userId, ...label, requestedAt: now().toISOString() };
          await mkdir(join(requestsRoot, reqId), { recursive: true });
          await writeJson(join(requestsRoot, reqId, 'request.json'), stored);
          deps.audit({ action: 'package.request', userId: caller.userId, target: id, details: { remove: true, requestId: reqId, ...auditVia(label) } });
          return publicRequest(stored);
        }
        if ('tarball' in ask) {
          const base64 = typeof ask.tarball?.base64 === 'string' ? ask.tarball.base64 : '';
          if (base64.length === 0 || base64.length > Math.ceil(deps.uploadMaxBytes() / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
            throw new PlatformPackageError(400, 'bad_tarball', `A tarball is a base64 .tgz of at most ${Math.round(deps.uploadMaxBytes() / (1024 * 1024))} MiB.`);
          }
          return stage(caller, label, async (dir) => {
            const tgz = join(dir, 'package.tgz');
            await writeFile(tgz, Buffer.from(base64, 'base64'));
            return { tgz, source: 'tarball' };
          });
        }
        const parsed = typeof ask.install === 'string' ? parseRegistrySpec(ask.install) : null;
        if (!parsed) throw new PlatformPackageError(400, 'bad_spec', 'Name a registry package as <name> or <name>@<version> (a .tgz is sent as a tarball).');
        if (deps.hostLines.has(parsed.name)) {
          throw new PlatformPackageError(409, 'shipped_with_host', `${parsed.name} is part of this host's own installation; that copy is the one that loads.`);
        }
        await refuseUnlisted(parsed.name);
        const npm = requireNpm();
        await refusePrivateScopes();
        return stage(caller, label, async (dir) => {
          const registry = deps.registryUrl();
          const run = await npm(['pack', `${parsed.name}@${parsed.range}`, '--json', '--pack-destination', dir], { cwd: dir, registry, timeoutMs: deps.timeoutMs() });
          if (run.code !== 0) {
            deps.log('npm pack failed', { spec: `${parsed.name}@${parsed.range}`, output: npmFailureText(run) });
            throw new PlatformPackageError(502, 'npm_failed', `npm could not fetch ${parsed.name}@${parsed.range}. The host log has npm's output.`);
          }
          let filename = '';
          try {
            const out = JSON.parse(run.stdout) as Array<{ filename?: unknown }>;
            filename = typeof out[0]?.filename === 'string' ? out[0].filename : '';
          } catch {
            filename = '';
          }
          // npm names it `<scope>-<name>-<version>.tgz`: one plain file name, never a path.
          if (!/^[A-Za-z0-9._-]+\.tgz$/.test(filename)) {
            throw new PlatformPackageError(502, 'npm_failed', `npm fetched ${parsed.name} but named no tarball.`);
          }
          const tgz = join(dir, filename);
          await stat(tgz).catch(() => { throw new PlatformPackageError(502, 'npm_failed', `npm fetched ${parsed.name} but wrote no tarball.`); });
          return { tgz, spec: `${parsed.name}@${parsed.range}`, source: 'registry', registry };
        });
      });
    },

    approve(caller, requestId, via) {
      return serial(async () => {
        await deps.authorize(caller, 'ask');
        // The request is resolved BEFORE the approve feature is checked: an unknown id is a 404 to every caller.
        if (!REQUEST_ID.test(requestId)) throw new PlatformPackageError(404, 'request_not_found', 'No such request.');
        const stored = (await listRequests()).find((r) => r.id === requestId);
        if (!stored) throw new PlatformPackageError(404, 'request_not_found', 'No such request (it may have expired).');
        await deps.authorize(caller, 'approve');
        const label = callerOf(caller, via);
        const done = stored.action === 'remove' ? await remove(caller, stored, label) : await install(caller, stored, label);
        await rm(join(requestsRoot, requestId), { recursive: true, force: true });
        return { action: stored.action, packageId: done.packageId, version: done.version, restartRequired: true as const };
      });
    },

    dismiss(caller, requestId) {
      return serial(async () => {
        await deps.authorize(caller, 'ask');
        if (!REQUEST_ID.test(requestId)) return false;
        const stored = (await listRequests()).find((r) => r.id === requestId);
        if (!stored) return false;
        await rm(join(requestsRoot, requestId), { recursive: true, force: true });
        deps.audit({ action: 'package.request_dismissed', userId: caller.userId, target: stored.summary.id, details: { requestId } });
        return true;
      });
    },

    async restart(caller, via) {
      await deps.authorize(caller, 'approve');
      if (deps.restartMode === 'manual') {
        throw new PlatformPackageError(409, 'restart_unsupervised', 'Nothing would start this host again after it stops: restart it the way it was started.');
      }
      deps.audit({ action: 'package.restart', userId: caller.userId, details: { restart: deps.restartMode, ...auditVia(callerOf(caller, via)) } });
      // After the answer has left: the host stops through its own drain, its supervisor starts it again.
      setTimeout(deps.stopForRestart, 300);
      return { restart: deps.restartMode };
    },
  };
}

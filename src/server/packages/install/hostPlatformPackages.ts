/**
 * The host's wiring of the runtime package install: the facts the transaction
 * (`platformPackages.ts`) reads from this process, and the one boot step it
 * owns — the peer links (`peerLinks.ts`) before the runtime provider loads.
 * `bootstrap.ts` calls these two functions and nothing else of the install.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasFeature } from '@neuralis/package-system/access';
import { detectDocker, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { loadPackageValidator } from '@neuralis/package-system';
import type { BuiltinRefusal, PackageDefinition, PackageDiagnosticsPort } from '@neuralis/package-system/contracts';
import { resolveMemberSession } from '../../auth/memberSession';
import { BUILTIN_PACKAGE_IDS, BUILTIN_ROOTS, HOST_ROOT, RUNTIME_INSTALL_DISCOVERY, hostDependencyNames, resolveHostDependencyRoot, runtimePackagesRoot } from '../../host/builtinSlots';
import { SUPERVISOR_ENV } from '../../host/homeLock';
import { getLogger } from '../../logging/setup';
import { bundledNpmCli, createNpmRunner } from './npm';
import { linkSharedPeers, sharedPeers } from './peerLinks';
import {
  createPlatformPackages,
  PLATFORM_PACKAGES_APPROVE_FEATURE,
  PLATFORM_PACKAGES_FEATURE,
  PlatformPackageError,
  type PlatformPackageRow,
  type PlatformPackagesPort,
} from './platformPackages';

type Logger = { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };

/**
 * Boot step: the record's peer links, derived for THIS host tree, and the
 * discovery facts an operator must see (a shadowed entry, an unreadable
 * record). Runs before the runtime provider imports any package.
 */
export function prepareRuntimePackages(appRoot: string, logger: Logger): void {
  const { installed, shadowed, unreadable } = RUNTIME_INSTALL_DISCOVERY;
  if (unreadable) logger.warn('the runtime package record is unreadable — no package installed while the host ran is loaded', { record: 'packages/package.json' });
  if (shadowed.length > 0) logger.warn('runtime-installed packages left out — the host ships its own copy', { shadowed });
  if (installed.size === 0) return;
  const root = runtimePackagesRoot(appRoot);
  try {
    const { linked, replaced } = linkSharedPeers(root, sharedPeers(root, installed, resolveHostDependencyRoot));
    if (linked.length > 0) logger.info('runtime package peers linked to the host\'s copies', { linked, replaced });
  } catch (err) {
    logger.warn('runtime package peers could not be linked — a package that imports one is refused at load', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The configured registry, when it is a URL the install may use: https, or http on loopback; never with credentials. */
export function registryUrlFrom(value: unknown): string {
  const refuse = (): never => {
    throw new PlatformPackageError(409, 'registry_invalid', 'The "Package Registry" setting is not an https URL (or http on this machine) without credentials.');
  };
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) return refuse();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return refuse();
  return url.toString();
}

type HostManifest = { version?: unknown; dependencies?: Record<string, string> };

function readManifest(path: string): HostManifest {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HostManifest;
  } catch {
    return {};
  }
}

/**
 * Where an image row came from. `operator`: the derived image of an npm install
 * folder lists it under `_operator/` (`operatorInstall`), or the host's own
 * line is not the release pin — a `pkg add` line in a source checkout, a local
 * folder or tarball. `core`: an `@neuralis/*` line the release pins to its own
 * version (`release:version` keeps every core line equal to it) or a workspace
 * link in the source tree.
 */
export function imageOrigin(id: string, hostLine: string | undefined, hostVersion: string, operatorIds: ReadonlySet<string>): 'core' | 'operator' {
  if (operatorIds.has(id)) return 'operator';
  if (id.startsWith('@neuralis/') && hostLine !== undefined && (hostLine === hostVersion || hostLine.startsWith('workspace:'))) return 'core';
  return 'operator';
}

/**
 * The host's own installation as rows, read once: the builtins discovered from
 * its manifest (the runtime record's are listed by the transaction itself),
 * each one's version from its package.json, its origin, and this start's
 * answer — `loaded`, `disabled` by the operator, or `refused`.
 */
function imageRowsOf(
  manifests: readonly PackageDefinition[],
  refused: readonly BuiltinRefusal[],
  loadedIds: () => ReadonlySet<string>,
): () => PlatformPackageRow[] {
  let rows: Array<Omit<PlatformPackageRow, 'status'>> | null = null;
  return () => {
    rows ??= (() => {
      const host = readManifest(join(HOST_ROOT, 'package.json'));
      const lines = host.dependencies ?? {};
      const operatorIds = new Set(Object.keys(readManifest(join(HOST_ROOT, '_operator', 'package.json')).dependencies ?? {}));
      return manifests
        .filter((m) => !RUNTIME_INSTALL_DISCOVERY.installed.has(m.id))
        .map((m) => {
          const root = BUILTIN_ROOTS.get(m.id);
          const version = root ? readManifest(join(root, 'package.json')).version : undefined;
          return {
            id: m.id,
            version: typeof version === 'string' ? version : '',
            slot: 'image' as const,
            origin: imageOrigin(m.id, lines[m.id], typeof host.version === 'string' ? host.version : '', operatorIds),
            optional: m.optional === true,
          };
        });
    })();
    const loaded = loadedIds();
    const reasons = new Map(refused.map((r) => [r.packageId, r.reason]));
    return rows.map((row) => ({
      ...row,
      status: reasons.get(row.id) === 'disabled' ? 'disabled' : loaded.has(row.id) ? 'loaded' : 'refused',
    }));
  };
}

export function createHostPlatformPackages(input: {
  appRoot: string;
  builtinManifests: readonly PackageDefinition[];
  /** The builtins this start left out before the runtime booted (`admitBuiltins`). */
  refusedBuiltins: readonly BuiltinRefusal[];
  /** What the runtime loaded (a builtin it refused at load or start is absent). */
  packageDiagnostics: Pick<PackageDiagnosticsPort, 'listDefinitions'>;
  configGet: (key: string) => unknown;
  configKeyOwner: (key: string) => string | undefined;
  runtimeProviderRoot: string;
  audit: (event: { action: string; userId: string; target?: string; details?: Record<string, unknown> }) => void;
}): PlatformPackagesPort {
  const cli = bundledNpmCli();
  let validator: ReturnType<typeof loadPackageValidator> | null = null;
  const number = (key: string): number => {
    const value = input.configGet(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
  };
  const loadedIds = (): ReadonlySet<string> => new Set(input.packageDiagnostics.listDefinitions().map((d) => d.id));
  const disabledIds = new Set(input.refusedBuiltins.filter((r) => r.reason === 'disabled').map((r) => r.packageId));
  return createPlatformPackages({
    appRoot: input.appRoot,
    home: resolveNeuralisHome().home,
    activeIds: BUILTIN_PACKAGE_IDS,
    runtimeInstalledAtBoot: RUNTIME_INSTALL_DISCOVERY.installed,
    bootRecordLines: RUNTIME_INSTALL_DISCOVERY.lines,
    hostLines: hostDependencyNames(),
    imageRows: imageRowsOf(input.builtinManifests, input.refusedBuiltins, loadedIds),
    refusedAtBoot: (id) => (disabledIds.has(id) ? 'disabled' : loadedIds().has(id) ? undefined : 'refused'),
    builtinDefinitions: () => input.builtinManifests,
    configKeyOwner: input.configKeyOwner,
    resolveHostPeer: resolveHostDependencyRoot,
    validate: async (root) => {
      validator ??= loadPackageValidator(input.runtimeProviderRoot);
      return (await validator).validate(root);
    },
    registryUrl: () => registryUrlFrom(input.configGet('packageRegistryUrl')),
    timeoutMs: () => number('packageInstallTimeoutMs'),
    uploadMaxBytes: () => number('packageUploadMaxMb') * 1024 * 1024,
    npm: cli ? createNpmRunner(cli) : null,
    authorize: async (caller, need) => {
      // FRESH, never the caller's cached grants: the session a route hands in
      // may be a stream's frozen snapshot. The same check for a person, an
      // agent's session and the CLI — the feature is the authority.
      const live = caller.projectId ? await resolveMemberSession(caller.userId, caller.projectId) : null;
      if (!live || !hasFeature(live, PLATFORM_PACKAGES_FEATURE)) {
        throw new PlatformPackageError(403, 'forbidden', `Installing packages needs '${PLATFORM_PACKAGES_FEATURE}'.`);
      }
      if (need === 'approve' && !hasFeature(live, PLATFORM_PACKAGES_APPROVE_FEATURE)) {
        throw new PlatformPackageError(403, 'forbidden', `Approving a package and restarting the host need '${PLATFORM_PACKAGES_APPROVE_FEATURE}' — ask someone whose role holds it.`);
      }
    },
    audit: input.audit,
    log: (message, meta) => getLogger().child('platform-packages').warn(message, meta),
    restartMode: process.env[SUPERVISOR_ENV] !== undefined ? 'supervised' : detectDocker(process.env) ? 'docker' : 'manual',
    // The SIGTERM event itself, as `followSupervisor` raises it: the drain runs first on every OS.
    stopForRestart: () => { process.emit('SIGTERM', 'SIGTERM'); },
  });
}

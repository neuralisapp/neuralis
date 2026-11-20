/**
 * The READ verdict on loaded source packages, for the host's own surfaces
 * (snapshot routes, first paint, chat, assets, notifications, the app scope).
 *
 * A package loaded from a synced source is advertised only to a caller the
 * source's uri-policy lets READ its files: the kernel derivation
 * (`@neuralis/package-system/access` `planReadFloor` → `deriveReadHidden`)
 * over brain-core's verdict, asked through the existing `package-source-roots`
 * service contract (`readablePackageUris`). One batched question per request.
 *
 * Fail closed: no service, a throwing service or a project-less request hides
 * every candidate. A project with no candidate asks nothing.
 */

import {
  deriveReadHidden,
  isManifestReadHidden,
  isReadFloorCandidate,
  packageFileUri,
  planReadFloor,
  type ReadHidden,
} from '@neuralis/package-system/access';
import type { PackageReadCaller, SessionContext } from '@neuralis/package-system/contracts';
import { getRuntime } from '../host/bootstrap';
import { getLogger } from '../logging/setup';
import { getCommunityPackageRuntime } from './runtime';

/**
 * Nothing hidden by a read — the answer for a project with no read-floor
 * candidate, and the `readHidden` of a PROJECT-LESS scope, whose ladder already
 * hides every loaded source package (`passesProjectAndOwnerScope`).
 */
export const NO_READ_HIDDEN: ReadHidden = { hiddenPackageIds: new Set(), hiddenFileKeys: new Set() };

/** The identity the verdict is read for — the request's own session. */
export type ReadFloorSession = Pick<SessionContext, 'userId' | 'agentId' | 'role' | 'priority' | 'rolePriorities' | 'grantedFeatures'>;

function callerOf(session: ReadFloorSession, projectId: string): PackageReadCaller {
  return {
    userId: session.userId,
    projectId,
    agentId: session.agentId ?? '',
    role: session.role,
    priority: session.priority,
    rolePriorities: session.rolePriorities,
    grantedFeatures: session.grantedFeatures ?? [],
  };
}

/** A verdict and whether brain-core gave it (`judged: false` = the fail-closed answer). */
interface ReadHiddenResult { readonly view: ReadHidden; readonly judged: boolean }

async function readHiddenFor(
  session: ReadFloorSession,
  projectId: string,
  packageIds?: Iterable<string>,
): Promise<ReadHiddenResult> {
  const plan = planReadFloor(getCommunityPackageRuntime().getSnapshot(), projectId, packageIds);
  if (plan.packages.length === 0) return { view: NO_READ_HIDDEN, judged: true };
  try {
    const sourceRoots = (await getRuntime()).services.get('package-source-roots');
    if (!sourceRoots) throw new Error('package-source-roots service unavailable');
    const readable = await sourceRoots.readablePackageUris(callerOf(session, projectId), plan.uris);
    return { view: deriveReadHidden(plan, readable), judged: true };
  } catch (error) {
    getLogger().warn('Source packages withheld: the read verdict is unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { view: deriveReadHidden(plan, null), judged: false };
  }
}

/**
 * The request's read half over the loaded source packages of the project —
 * every one, or only `packageIds` for a surface that resolves one package.
 */
export async function loadReadHiddenView(
  session: ReadFloorSession,
  projectId: string,
  packageIds?: Iterable<string>,
): Promise<ReadHidden> {
  return (await readHiddenFor(session, projectId, packageIds)).view;
}

/**
 * One package's verdict for a surface it contributes through its manifest
 * (a widget, a card, a dock entry, an asset, a notification): `'hidden'` when
 * the package is hidden whole or its `package.json` is unreadable to the
 * caller, `'unjudged'` when the verdict was unavailable (hidden all the same —
 * but never a reason for a write such as dropping a stored row).
 */
export async function loadPackageReadVerdict(
  session: ReadFloorSession,
  projectId: string,
  packageId: string,
): Promise<'visible' | 'hidden' | 'unjudged'> {
  const { view, judged } = await readHiddenFor(session, projectId, [packageId]);
  if (!isManifestReadHidden(view, packageId)) return 'visible';
  return judged ? 'hidden' : 'unjudged';
}

/** {@link loadPackageReadVerdict} as a yes/no. */
export async function isPackageReadVisible(
  session: ReadFloorSession,
  projectId: string,
  packageId: string,
): Promise<boolean> {
  return (await loadPackageReadVerdict(session, projectId, packageId)) === 'visible';
}

/** A listed package folder of a switched-off source, as the visibility question needs it. */
export type DisabledFolderRow = { readonly packageId: string; readonly sourceSlug: string; readonly originUri: string };

/**
 * Which listed package folders of switched-off sources the request's own
 * session may see: brain-core admits the source at source level
 * (`listDisabledSourceSlugs`) AND the folder's `package.json` passes the path
 * axis (`readablePackageUris`) — the verdict the same folder is shown by when
 * its source is on. A drop-zone row (`packages://`) is exempt from the path
 * axis, as a loaded drop is. Two questions per request at most; fail closed:
 * no service or a throwing one admits none.
 */
export async function loadVisibleDisabledPackageIds(
  session: ReadFloorSession,
  projectId: string,
  rows: readonly DisabledFolderRow[],
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  try {
    const sourceRoots = (await getRuntime()).services.get('package-source-roots');
    if (!sourceRoots) throw new Error('package-source-roots service unavailable');
    const caller = callerOf(session, projectId);
    const slugs = new Set(await sourceRoots.listDisabledSourceSlugs(caller));
    const admitted = rows.filter((row) => slugs.has(row.sourceSlug));
    const judged = admitted.filter((row) => isReadFloorCandidate(row.packageId));
    const manifestOf = (row: DisabledFolderRow): string => packageFileUri(row.originUri, 'package.json');
    const readable = judged.length > 0 ? await sourceRoots.readablePackageUris(caller, judged.map(manifestOf)) : new Set<string>();
    return new Set(admitted.filter((row) => !isReadFloorCandidate(row.packageId) || readable.has(manifestOf(row))).map((row) => row.packageId));
  } catch (error) {
    getLogger().warn('Switched-off source packages withheld: the source read verdict is unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}

/**
 * packageVisibility — the ONE shared package/surface visibility predicate
 * (CARD1 3A).
 *
 * EXTRACTED (not copied) from `snapshot.ts`'s `buildScopedSnapshot` ladder so
 * the scoped snapshot and the identity-free asset-scope routes can never
 * drift: host filter → project filter (builtins ∪ this project's packages) →
 * R2b source-owner scope (`canAccessScope(..., 'read')`) → base-access
 * feature (manifest `requires.accessFeature` ∪ project override, each
 * independently required) → per-surface `requires.features` → trust /
 * renderer declaration. `snapshot.ts` calls these SAME helpers per
 * definition; the asset mint/GET routes call `resolveVisiblePackageSurface`,
 * which runs the FULL ladder for one exact surface, and — for a dock entry's
 * declared picture — `resolveVisiblePackageDockImage`, which runs the same
 * ladder plus the ONE dock rule (`isDockEntryGranted`) the snapshot applies.
 *
 * Deny-by-default: every unresolved input (missing definition, missing
 * surface, failed feature, error-status package, undeclared renderer) yields
 * "not visible" — the routes answer with ONE uniform non-enumerating
 * response, never an existence-confirming error.
 */

import {
  meetsRequires,
  canAccessScope,
  hasFeature,
  isAbsoluteAssetUrl,
  isHtmlEntryPath,
  resolveDockImagePath,
} from '@neuralis/package-system';
import type {
  CardUiElement,
  DockUiElement,
  HostTarget,
  PackageDefinition,
  PackageTrust,
  SessionContext,
  SurfaceAssetMode,
  WidgetUiElement,
} from '@neuralis/package-system/contracts';
import type { SurfaceAssetKind } from '@neuralis/package-system';
import { createHash } from 'node:crypto';
import { getCommunityPackageRegistry } from './runtime';
import { getPackageRuntimeManager } from './PackageRuntimeManager';
import { BUILTIN_PACKAGE_IDS } from '../host/bootstrap';
import { getProjectById } from '../store/ProjectStore';

/**
 * Caller scope for the visibility ladder — the same shape `snapshot.ts` used
 * as its private `SnapshotScope` (moved here so both consumers share it).
 */
export type PackageVisibilityScope = {
  host: HostTarget;
  projectId?: string;
  userId?: string;
  agentId?: string;
  role?: string;
  grantedFeatures?: string[];
  /** R2b — owner/admin base-access feature OVERRIDE map (runtime instance id → feature id). */
  packageAccessFeature?: Record<string, string>;
};

type FeatureFiltered = {
  requires?: {
    features?: string[];
  };
};

/**
 * Host-side wrapper over the canonical `meetsRequires` predicate
 * (`@neuralis/package-system/access`) — do NOT inline another copy of the
 * wildcard/AND logic. The one host-specific convention kept here:
 * `grantedFeatures === undefined` means "no caller scope" (legacy/unscoped
 * snapshot calls) and passes unfiltered.
 */
export function hasRequiredFeatures(entry: FeatureFiltered, grantedFeatures?: string[]): boolean {
  if (!grantedFeatures) return true;
  return meetsRequires({ grantedFeatures }, entry.requires);
}

/**
 * R2b — whole-package base-access feature gate. The effective requirement is the
 * manifest `requires.accessFeature` ∪ the project override (`packageAccessFeature`),
 * each independently required (most-restrictive / tighten-only). Uses the ONE
 * shared `hasFeature` predicate — no inline wildcard logic.
 */
export function passesBaseAccessFeature(
  definition: PackageDefinition,
  grantedFeatures: string[],
  overrideFeature: string | undefined,
): boolean {
  const manifestFeature = definition.requires?.accessFeature;
  for (const feature of [manifestFeature, overrideFeature]) {
    if (feature && !hasFeature({ grantedFeatures }, feature)) return false;
  }
  return true;
}

/** Mutable overrides belong to the exact runtime instance; authored feature gates stay separate. */
export function resolveOverrideFeature(
  scope: Pick<PackageVisibilityScope, 'projectId' | 'packageAccessFeature'>,
  definitionId: string,
): string | undefined {
  const overrides = scope.packageAccessFeature;
  if (!overrides) return undefined;
  return overrides[definitionId];
}

/** Step 1 of the ladder — `meta.hosts` targeting. */
export function matchesHost(definition: PackageDefinition, host: HostTarget): boolean {
  const hosts = definition.meta?.hosts;
  return !hosts || hosts.length === 0 || hosts.includes(host);
}

/**
 * Step 2 + 2b of the ladder — project install membership (builtins ∪ this
 * project's packages) and R2b source-owner scope isolation.
 */
export function passesProjectAndOwnerScope(
  definition: PackageDefinition,
  scope: PackageVisibilityScope,
): boolean {
  const projectId = scope.projectId;
  if (!projectId) return true;
  if (BUILTIN_PACKAGE_IDS.has(definition.id)) return true; // builtins never scope-hidden
  const manager = getPackageRuntimeManager();
  if (!manager.getProjectPackageIds(projectId).has(definition.id)) return false;
  // R2b — scope isolation: a package owned by a user/agent-scoped source is
  // hidden unless the caller can access that scope. No recorded owner scope
  // (default `_packages/`) ⇒ undefined ⇒ implicit project scope ⇒ visible.
  const ownerScope = manager.getPackageOwnerScope(projectId, definition.id);
  if (!ownerScope) return true;
  return canAccessScope(
    ownerScope,
    {
      userId: scope.userId ?? '',
      agentId: scope.agentId,
      role: scope.role,
      grantedFeatures: scope.grantedFeatures,
    },
    'read',
  );
}

/**
 * Whole-package visibility for one definition — the exact ladder
 * `buildScopedSnapshot` applies as three successive array filters.
 * `grantedFeatures` is threaded SEPARATELY (snapshot convention: `undefined`
 * ⇒ legacy unscoped call ⇒ base-access gate skipped).
 */
export function isPackageDefinitionVisible(
  definition: PackageDefinition,
  scope: PackageVisibilityScope,
  grantedFeatures?: string[],
): boolean {
  if (!matchesHost(definition, scope.host)) return false;
  if (!passesProjectAndOwnerScope(definition, scope)) return false;
  if (
    grantedFeatures &&
    !passesBaseAccessFeature(definition, grantedFeatures, resolveOverrideFeature(scope, definition.id))
  ) {
    return false;
  }
  return true;
}

/**
 * THE ONE dock-entry visibility rule — the scoped snapshot, the dock-picture
 * mint and its every GET/heartbeat recheck all call it. The entry's own
 * `requires.features` must pass; an `open-widget` entry ALSO needs its TARGET
 * widget's features. A target that is not among the caller-visible widgets
 * (none declared, an untrusted absolute url the snapshot drops, a package the
 * caller cannot see) leaves the entry visible: that is the snapshot's
 * long-standing semantics, preserved here verbatim rather than tightened for
 * one consumer — a second, stricter copy is how the dock and its picture would
 * start disagreeing.
 */
export function isDockEntryGranted(
  dock: Pick<DockUiElement, 'requires' | 'action'>,
  grantedFeatures: string[] | undefined,
  findTargetWidget: (widgetType: string) => FeatureFiltered | undefined,
): boolean {
  if (!hasRequiredFeatures(dock, grantedFeatures)) return false;
  if (dock.action.type !== 'open-widget') return true;
  const target = findTargetWidget(dock.action.widget);
  return target ? hasRequiredFeatures(target, grantedFeatures) : true;
}

/**
 * The widget an `open-widget` dock action resolves to, among the widgets the
 * snapshot would carry for these caller-visible definitions: same drop rule
 * (an untrusted package's absolute url), same last-declared-wins order as the
 * snapshot's type map.
 */
function findVisibleTargetWidget(
  definitions: PackageDefinition[],
  widgetType: string,
): WidgetUiElement | undefined {
  let found: WidgetUiElement | undefined;
  for (const definition of definitions) {
    const trust = definition.access?.trust;
    for (const entry of definition.app?.surfaces ?? []) {
      if (entry.kind !== 'widget') continue;
      const widget = entry as WidgetUiElement;
      if (widget.type !== widgetType) continue;
      const url = widget.component?.url;
      if (url && isAbsoluteAssetUrl(url) && trust === 'untrusted') continue;
      found = widget;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Exact-surface resolution (asset-scope mint / GET)
// ---------------------------------------------------------------------------

export type VisiblePackageSurface = {
  packageId: string;
  /**
   * Authored manifest id from `getPackageManifestId` (packageId for builtins).
   * Descriptive metadata only: asset roots resolve by the exact packageId,
   * because distinct installations can share an authored name.
   */
  manifestId: string;
  surfaceKind: SurfaceAssetKind;
  /** K1 — the EXACT declared identity: widget → `type`, card → `id`. */
  surfaceId: string;
  renderer: string;
  /** Raw declared entry url (`component.url` / `render.url`), if any. */
  entryUrl?: string;
  /**
   * NORMALIZED asset mode — never the raw manifest value. REQUIRED, not
   * optional, so every construction site of this type has to make the decision
   * explicitly and tsc catches a new one that forgets.
   */
  assetMode: SurfaceAssetMode;
  trust: PackageTrust;
  /** Server-computed surface fingerprint (renderer/url/bridge/trust digest). */
  fingerprint: string;
  /** Per-load package generation — changes when the definition is re-registered. */
  generation: string;
  definition: PackageDefinition;
};

/**
 * Per-load package generation. `PackageRegistry.listPackages()` returns the
 * SAME definition objects until a package is re-registered (install / update /
 * reload replace the object), so a WeakMap identity stamp is a faithful
 * "generation" signal: a package update mints a new stamp and every asset
 * handle bound to the old one revokes with 410 on its next recheck. Process
 * restart clears both the stamps and the (in-memory) scope authority.
 */
const definitionGenerations = new WeakMap<object, string>();
let generationCounter = 0;

export function getDefinitionGeneration(definition: PackageDefinition): string {
  const key = definition as unknown as object;
  const existing = definitionGenerations.get(key);
  if (existing) return existing;
  generationCounter += 1;
  const stamp = `gen_${generationCounter}`;
  definitionGenerations.set(key, stamp);
  return stamp;
}

/**
 * THE ONE PLACE a declared `assetMode` becomes an effective one. Manifest data
 * is untrusted input, so the declaration is a REQUEST and this is the decision:
 * `'bundle'` survives only when every condition that makes it MEANINGFUL holds,
 * and every other input — including an unknown string, a `direct`/`mcp`
 * renderer, an absolute url or a non-HTML entry — resolves to `self-contained`,
 * which is the import-unchanged floor.
 *
 * Each condition earns its place:
 *  - exact `'bundle'` string: a typo must not opt a surface in;
 *  - `iframe` renderer: a `direct` React surface has no document to inject into;
 *  - RELATIVE url: an absolute/remote surface is served by someone else, and the
 *    mint route refuses to create an asset scope for one at all;
 *  - HTML entry (the KERNEL predicate, never a second extension test): a
 *    `<base>` means nothing outside an HTML document, and nothing upstream
 *    guarantees the entry is one — the validator only WARNS.
 *
 * Do NOT re-derive this anywhere. A second copy is how the mint side and the
 * serve side start disagreeing about what a surface is.
 */
export function normalizeSurfaceAssetMode(
  declared: unknown,
  renderer: string,
  url: string | undefined,
): SurfaceAssetMode {
  if (declared !== 'bundle') return 'self-contained';
  if (renderer !== 'iframe') return 'self-contained';
  if (!url || isAbsoluteAssetUrl(url)) return 'self-contained';
  if (!isHtmlEntryPath(url)) return 'self-contained';
  return 'bundle';
}

/**
 * Stable digest of a dock picture's declaration — the purpose, the dock, the
 * normalized picture path, the action target and the trust. A changed
 * declaration (a new path, a re-targeted entry, a trust change) mints a new
 * value, so every handle bound to the old one answers 410 on its next recheck;
 * the package generation is compared beside it, as for every scope.
 */
export function computeDockImageFingerprint(input: {
  dockId: string;
  imagePath: string;
  target: string;
  trust: PackageTrust;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(['icon', input.dockId, input.imagePath, input.target, input.trust]))
    .digest('base64url')
    .slice(0, 24);
}

/** Stable digest of the surface's runtime-relevant declaration. */
export function computeSurfaceFingerprint(input: {
  surfaceKind: SurfaceAssetKind;
  surfaceId: string;
  renderer: string;
  url?: string;
  importKey?: string;
  bridgeEnabled: boolean;
  trust: PackageTrust;
  /**
   * The NORMALIZED mode, and REQUIRED. Without it a `bundle` → `self-contained`
   * flip would leave every live scope un-revoked, and the frame would keep
   * running with an injected `<base>` the declaration no longer authorizes.
   */
  assetMode: SurfaceAssetMode;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.surfaceKind,
        input.surfaceId,
        input.renderer,
        input.url ?? null,
        input.importKey ?? null,
        input.bridgeEnabled,
        input.trust,
        // APPENDED, never inserted: a new field in the middle would change every
        // existing fingerprint and revoke every live scope for no reason.
        input.assetMode,
      ]),
    )
    .digest('base64url');
  return digest.slice(0, 24);
}

/**
 * Resolve ONE exact, caller-visible widget/card surface — the full shared
 * ladder plus install/status, per-surface features, trust and renderer
 * declaration. Returns `null` for EVERY not-visible reason (uninstalled,
 * scope-hidden, feature-hidden, error status, unknown surface, undeclared
 * renderer) so callers answer with one uniform non-enumerating response.
 *
 * The caller passes the VERIFIED session — in particular `session.agentId`
 * must already be the `resolveVerifiedAgentScope` result, never the raw
 * `x-agent-id` header (K7).
 */
export async function resolveVisiblePackageSurface(
  session: SessionContext,
  packageId: string,
  surfaceKind: SurfaceAssetKind,
  surfaceId: string,
): Promise<VisiblePackageSurface | null> {
  if (surfaceKind !== 'widget' && surfaceKind !== 'card') return null;
  if (!surfaceId) return null;
  const visible = await resolveVisibleDefinition(session, packageId);
  if (!visible) return null;
  const { definition } = visible;
  if (!session.projectId) return null;

  const surface = (definition.app?.surfaces ?? []).find((entry) => {
    if (surfaceKind === 'widget') {
      return entry.kind === 'widget' && (entry as WidgetUiElement).type === surfaceId;
    }
    return entry.kind === 'card' && (entry as CardUiElement).id === surfaceId;
  }) as WidgetUiElement | CardUiElement | undefined;
  if (!surface) return null;

  // Per-surface feature gate (S2 parity with `isUiEntryGranted`).
  if (!hasRequiredFeatures(surface as FeatureFiltered, session.grantedFeatures)) return null;

  const render = surfaceKind === 'widget'
    ? (surface as WidgetUiElement).component
    : (surface as CardUiElement).render;
  if (!render?.renderer) return null;

  const trust: PackageTrust = definition.access?.trust ?? 'untrusted';
  const url = render.url;

  // Untrusted + absolute URL is dropped at the snapshot too — mirror it here
  // through the KERNEL predicate (`surfaceLayout.isAbsoluteAssetUrl`), the same
  // one `snapshot.ts` and `validateContribution.ts` call. A re-written regex
  // here would let the mint-side drop drift away from the snapshot-side drop
  // the moment the kernel widens the rule.
  if (url && isAbsoluteAssetUrl(url) && trust === 'untrusted') {
    return null;
  }

  const bridgeEnabled = (surface as { bridge?: { enabled?: boolean } }).bridge?.enabled === true;
  const assetMode = normalizeSurfaceAssetMode(render.assetMode, render.renderer, url);

  return {
    packageId: definition.id,
    manifestId:
      getPackageRuntimeManager().getPackageManifestId(session.projectId, definition.id) ??
      definition.id,
    surfaceKind,
    surfaceId,
    renderer: render.renderer,
    entryUrl: url,
    assetMode,
    trust,
    fingerprint: computeSurfaceFingerprint({
      surfaceKind,
      surfaceId,
      renderer: render.renderer,
      url,
      importKey: render.import,
      bridgeEnabled,
      trust,
      assetMode,
    }),
    generation: getDefinitionGeneration(definition),
    definition,
  };
}

export type VisiblePackageDockImage = {
  packageId: string;
  dockId: string;
  /** Normalized package-relative picture path (`app/shared/…`). */
  imagePath: string;
  /** The same path relative to `app/shared/`. */
  sharedRel: string;
  trust: PackageTrust;
  /** Server-computed picture fingerprint (`computeDockImageFingerprint`). */
  fingerprint: string;
  generation: string;
};

/**
 * Resolve ONE exact, caller-visible dock entry's declared picture — the same
 * whole-package ladder as {@link resolveVisiblePackageSurface}, then the ONE
 * dock rule ({@link isDockEntryGranted}, target widget included) and the
 * kernel's structural picture rule. `null` for every not-visible reason, and
 * for an entry that declares no (valid) picture: the caller never names a
 * path, so there is nothing else to serve.
 */
export async function resolveVisiblePackageDockImage(
  session: SessionContext,
  packageId: string,
  dockId: string,
): Promise<VisiblePackageDockImage | null> {
  if (!dockId) return null;
  const visible = await resolveVisibleDefinition(session, packageId);
  if (!visible) return null;
  const { definition, scope, definitions } = visible;

  const dock = (definition.app?.surfaces ?? []).find(
    (entry) => entry.kind === 'dock' && (entry as DockUiElement).id === dockId,
  ) as DockUiElement | undefined;
  if (!dock || typeof dock.image !== 'string') return null;
  const image = resolveDockImagePath(dock.image);
  if (!image.ok) return null;

  const granted = isDockEntryGranted(dock, session.grantedFeatures, (widgetType) =>
    findVisibleTargetWidget(
      definitions.filter((candidate) => isPackageDefinitionVisible(candidate, scope, session.grantedFeatures)),
      widgetType,
    ),
  );
  if (!granted) return null;

  const trust: PackageTrust = definition.access?.trust ?? 'untrusted';
  const target = dock.action.type === 'open-widget'
    ? `widget:${dock.action.widget}`
    : `action:${dock.action.id}`;
  return {
    packageId: definition.id,
    dockId,
    imagePath: image.path,
    sharedRel: image.sharedRel,
    trust,
    fingerprint: computeDockImageFingerprint({ dockId, imagePath: image.path, target, trust }),
    generation: getDefinitionGeneration(definition),
  };
}

/**
 * The whole-package half both exact resolvers share: a registered definition,
 * not in `error` status, visible to this session through the shared ladder
 * (host → project + owner scope → base access with the project's override).
 */
async function resolveVisibleDefinition(
  session: SessionContext,
  packageId: string,
): Promise<{ definition: PackageDefinition; scope: PackageVisibilityScope; definitions: PackageDefinition[] } | null> {
  if (!session.projectId || !session.userId) return null;

  const definitions = getCommunityPackageRegistry().listPackages();
  const definition = definitions.find((candidate) => candidate.id === packageId);
  if (!definition) return null;

  // Disabled/error status — a package whose load failed must not serve assets
  // (fail-closed). `partial` means the CODE runtime is unavailable — a missing
  // build, a crashed runtime, or a trust demotion (`untrusted-node`,
  // `untrusted-mcp`) — while every declarative contribution did register, so
  // its static assets stay valid and are still served.
  const status = getPackageRuntimeManager().getLoader().getStatus(packageId);
  if (status?.status === 'error') return null;

  let packageAccessFeature: Record<string, string> | undefined;
  try {
    const project = await getProjectById(session.projectId);
    packageAccessFeature = project?.packageAccessFeature;
  } catch {
    // DENY-BY-DEFAULT: if the override map cannot be resolved, hide.
    return null;
  }

  const scope: PackageVisibilityScope = {
    // The SAME host target the four snapshot routes pass (`runtime/widgets/
    // dock/commands` → `host: 'neuralis-workspace'`) — the asset routes serve
    // the same workspace surface.
    host: 'neuralis-workspace',
    projectId: session.projectId,
    userId: session.userId,
    agentId: session.agentId,
    role: session.role,
    grantedFeatures: session.grantedFeatures,
    packageAccessFeature,
  };
  if (!isPackageDefinitionVisible(definition, scope, session.grantedFeatures)) return null;
  return { definition, scope, definitions };
}

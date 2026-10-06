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
 * which runs the FULL ladder for one exact surface.
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
} from '@neuralis/package-system';
import type {
  CardUiElement,
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
  /** R2b — owner/admin base-access feature OVERRIDE map (manifest id → feature id). */
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

/**
 * R2b — resolve the project override feature for a (possibly scope-namespaced)
 * registry package id. The admin override map is keyed by the RAW manifest id,
 * so translate namespaced→manifest before matching.
 */
export function resolveOverrideFeature(
  scope: Pick<PackageVisibilityScope, 'projectId' | 'packageAccessFeature'>,
  definitionId: string,
): string | undefined {
  const overrides = scope.packageAccessFeature;
  if (!overrides) return undefined;
  const manifestId = scope.projectId
    ? (getPackageRuntimeManager().getPackageManifestId(scope.projectId, definitionId) ?? definitionId)
    : definitionId;
  return overrides[manifestId] ?? overrides[definitionId];
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

// ---------------------------------------------------------------------------
// Exact-surface resolution (asset-scope mint / GET)
// ---------------------------------------------------------------------------

export type VisiblePackageSurface = {
  packageId: string;
  /**
   * RAW manifest id (namespaced→manifest translated via the ONE
   * `getPackageManifestId` map; falls back to `packageId` for builtins).
   * The `ProjectPackageScanner` records key on this — NEVER pass the
   * namespaced `packageId` to a scanner lookup (BUG-A: both lookups miss and
   * every project-package mint answers 404).
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
  if (!session.projectId || !session.userId) return null;
  if (surfaceKind !== 'widget' && surfaceKind !== 'card') return null;
  if (!surfaceId) return null;

  const definition = getCommunityPackageRegistry()
    .listPackages()
    .find((candidate) => candidate.id === packageId);
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

import { PackageSnapshotService, isAbsoluteAssetUrl } from '@neuralis/package-system';
import type {
  CardRuntimeDefinition,
  CommandRuntimeDefinition,
  DockRuntimeDefinition,
  FileRuntimeDefinition,
  PackageDefinition,
  PackageRuntimeSnapshot,
  PackageTrust,
  TeamMemberRuntimeDefinition,
  ToolRuntimeDefinition,
  WidgetRuntimeDefinition,
  WorkflowRuntimeDefinition,
} from '@neuralis/package-system/contracts';
import { getCommunityPackageRegistry, getCommunityPackageRuntime } from './runtime';
import { getPackageRuntimeManager } from './PackageRuntimeManager';
// CARD1 3A — the visibility ladder is EXTRACTED into `packageVisibility.ts`
// (the ONE shared predicate; the identity-free asset-scope routes run the SAME
// helpers). This file only composes the ladder over the snapshot arrays.
import {
  hasRequiredFeatures,
  matchesHost,
  passesBaseAccessFeature,
  passesProjectAndOwnerScope,
  resolveOverrideFeature,
  type PackageVisibilityScope,
} from './packageVisibility';

const GLOBAL_KEY = '__neuralis_snapshot_service__' as const;

function getService(): PackageSnapshotService {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new PackageSnapshotService(getCommunityPackageRuntime());
  }
  return g[GLOBAL_KEY] as PackageSnapshotService;
}

// R2b — caller identity for scope-isolated package advertise. When present and
// a package is owned by a user/agent-scoped source, it is hidden unless the
// caller matches (or holds `filesystem.observeScoped` — the ONE shared
// `canAccessScope`, which since D-A has NO role-name conjunct: the grant alone
// carries the decision, so a custom role granted it passes exactly like owner
// via `'*'` or admin via its enumerated default grant).
// Absent userId ⇒ scoped packages are hidden (deny-by-default first paint);
// builtins + project-scope packages are unaffected. The shape moved to
// `packageVisibility.ts` with the ladder; this alias keeps the route callers'
// vocabulary.
type SnapshotScope = PackageVisibilityScope;

type FeatureFiltered = {
  requires?: {
    features?: string[];
  };
};

/**
 * Prefix of the HOST-INTERNAL logical asset descriptor
 * (`/api/packages/{packageId}/app/{path}`). Since CARD1 3A this is snapshot /
 * fingerprint / resolution DATA ONLY — the legacy asset GET route it once
 * named is DELETED. The descriptor must never reach a DOM attribute,
 * `window.open`, an iframe `src` or a package payload: the client mints an
 * opaque asset scope (`POST /api/packages/{id}/app-scope`) and navigates the
 * identity-free `/api/package-app/_scope/{handle}/…` URL instead. Since CARD1
 * 3C BOTH widget and card entries are normalized through the same rule
 * (`normalizeSurfaceAssetUrl`).
 */
const PACKAGE_APP_ASSET_PREFIX = '/api/packages';

function buildTools(
  definitions: PackageDefinition[],
  grantedFeatures?: string[],
): ToolRuntimeDefinition[] {
  return definitions.flatMap((definition) =>
    (definition.tools ?? [])
      // S2b — `PackageTool.requires` gates the client-facing snapshot too
      // (parity with the files/commands/team/ui filters): a feature-gated tool
      // must not reach an under-privileged caller's browser payload at all.
      .filter((tool) => hasRequiredFeatures(tool, grantedFeatures))
      .map((tool) => ({
        ...tool,
        packageId: definition.id,
        source: definition.source?.kind,
      })),
  );
}

function buildContributions(
  definitions: PackageDefinition[],
  pick: (def: PackageDefinition) => PackageDefinition['skills'],
  grantedFeatures?: string[],
): FileRuntimeDefinition[] {
  return definitions.flatMap((definition) =>
    (pick(definition) ?? [])
      // S2 — `PackageFile.requires` gates the client-facing snapshot too
      // (parity with the commands/team/ui filters below): a feature-gated
      // file must not reach a member's browser payload at all.
      .filter((file) => hasRequiredFeatures(file, grantedFeatures))
      .map((file) => ({
        ...file,
        packageId: definition.id,
        source: definition.source?.kind,
      })),
  );
}

function buildWorkflows(
  definitions: PackageDefinition[],
  grantedFeatures?: string[],
): WorkflowRuntimeDefinition[] {
  return definitions.flatMap((definition) =>
    (definition.workflows ?? [])
      // S2d — `PackageWorkflow.requires` gates the client-facing snapshot too
      // (parity with the tools/files filters): a feature-gated template must
      // not reach an under-privileged caller's browser payload at all.
      .filter((workflow) => hasRequiredFeatures(workflow, grantedFeatures))
      .map((workflow) => ({
        ...workflow,
        packageId: definition.id,
        source: definition.source?.kind,
      })),
  );
}

function buildTeam(definitions: PackageDefinition[]): TeamMemberRuntimeDefinition[] {
  return definitions.flatMap((definition) =>
    (definition.team ?? []).map((member) => ({
      ...member,
      packageId: definition.id,
      source: definition.source?.kind,
    })),
  );
}

/** Outcome of the ONE asset-url rule shared by every iframe-rendered surface. */
type SurfaceUrlNormalization =
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'rewrite'; url: string };

/**
 * The ONE iframe asset-url rule — applied identically to WIDGET
 * `component.url` and CARD `render.url` (CARD1 3C M1: cards previously
 * bypassed normalization entirely, so an untrusted absolute card URL survived
 * the snapshot and the §5 "untrusted absolute iframe fail-closed" floor was
 * only 2/3 enforced).
 *
 * Rules:
 *   - No url → keep the entry unchanged (a `direct` surface has no url).
 *   - Absolute URL (`http://`, `https://`, `//`, or leading `/`):
 *       - first-party / trusted packages: allowed as-is;
 *       - untrusted packages: DROPPED with a warning — an untrusted surface
 *         may not load remote content and must ship its own asset under
 *         `_packages/{slug}/app/surfaces/{kind}/{surfaceId}/`.
 *   - Relative URL: rewritten to the host-internal LOGICAL descriptor
 *       `/api/packages/{packageId}/app/{url}`.
 *     This descriptor is NEVER navigated: the client renderer treats it as
 *     "asset-backed", mints an opaque identity-free asset scope server-side
 *     and loads `/api/package-app/_scope/{handle}/surface/…` instead. No
 *     `?projectId=` is ever appended to any iframe URL.
 *
 * `isAbsoluteAssetUrl` is the kernel's ONE predicate
 * (`@neuralis/package-system` → `validation/surfaceLayout.ts`), shared with
 * the contribution validator and the asset-scope routes — never re-spelled here.
 */
function normalizeSurfaceAssetUrl(params: {
  url: string | undefined;
  packageId: string;
  trust: PackageTrust | undefined;
  surfaceLabel: string;
}): SurfaceUrlNormalization {
  const { url, packageId, trust, surfaceLabel } = params;
  if (!url) return { action: 'keep' };

  if (isAbsoluteAssetUrl(url)) {
    if (trust === 'untrusted') {
      console.warn(
        `[snapshot] Dropping ${surfaceLabel} from package '${packageId}': ` +
          `untrusted packages may not reference absolute iframe URLs (got "${url}"). ` +
          `Use a relative path to a file under _packages/${packageId}/app/.`,
      );
      return { action: 'drop' };
    }
    return { action: 'keep' };
  }

  const stripped = url.replace(/^\.?\/+/, '');
  return { action: 'rewrite', url: `${PACKAGE_APP_ASSET_PREFIX}/${packageId}/app/${stripped}` };
}

/**
 * Run the shared asset-url rule across any UI entry.
 *
 * `widget` writes back to `component.url`, `card` to `render.url`; every other
 * kind (dock) carries no asset url and passes through.
 */
function normalizeUiEntry(
  entry: PackageRuntimeSnapshot['surfaces'][number],
  trustByPackageId: Map<string, PackageTrust>,
): PackageRuntimeSnapshot['surfaces'][number] | null {
  const trust = trustByPackageId.get(entry.packageId);

  if (entry.kind === 'widget') {
    const widget = entry as WidgetRuntimeDefinition;
    const result = normalizeSurfaceAssetUrl({
      url: widget.component?.url,
      packageId: widget.packageId,
      trust,
      surfaceLabel: `widget '${widget.type}'`,
    });
    if (result.action === 'drop') return null;
    if (result.action === 'keep') return widget;
    return { ...widget, component: { ...widget.component, url: result.url } };
  }

  if (entry.kind === 'card') {
    const card = entry as CardRuntimeDefinition;
    const render = card.render;
    const result = normalizeSurfaceAssetUrl({
      url: render?.url,
      packageId: card.packageId,
      trust,
      surfaceLabel: `card '${card.type}'`,
    });
    if (result.action === 'drop') return null;
    if (result.action === 'keep' || !render) return card;
    return { ...card, render: { ...render, url: result.url } };
  }

  return entry;
}

function buildScopedSnapshot(scope: SnapshotScope, grantedFeatures?: string[]): PackageRuntimeSnapshot {
  const base = getService().getFullSnapshot();
  const registry = getCommunityPackageRegistry();
  const loader = getPackageRuntimeManager().getLoader();

  // Step 1: filter by host (shared ladder — `packageVisibility.matchesHost`)
  let visibleDefinitions = registry
    .listPackages()
    .filter((definition) => matchesHost(definition, scope.host));

  // Step 2 + 2b: filter by projectId (builtins ∪ this project's packages) and
  // R2b source-owner scope isolation — shared `passesProjectAndOwnerScope`.
  if (scope.projectId) {
    visibleDefinitions = visibleDefinitions.filter((definition) =>
      passesProjectAndOwnerScope(definition, scope),
    );
  }

  // R2b — base-access feature gate (whole-package, all classes incl. builtins).
  // A package is hidden if its manifest `requires.accessFeature` OR the project
  // override attaches a feature the caller does not hold. `grantedFeatures`
  // undefined ⇒ unscoped admin view ⇒ no gate (matches `hasRequiredFeatures`).
  // The override map is manifest-id-keyed; the shared `resolveOverrideFeature`
  // translates namespaced→manifest (split-brain guard, see packageVisibility).
  if (grantedFeatures) {
    visibleDefinitions = visibleDefinitions.filter((definition) =>
      passesBaseAccessFeature(definition, grantedFeatures, resolveOverrideFeature(scope, definition.id)),
    );
  }

  const visiblePackageIds = new Set(visibleDefinitions.map((definition) => definition.id));

  // Build trust map from the registry so widget URL normalization can decide
  // whether to allow absolute URLs or require the host asset prefix.
  const trustByPackageId = new Map<string, PackageTrust>();
  for (const def of visibleDefinitions) {
    if (def.access?.trust) trustByPackageId.set(def.id, def.access.trust);
  }

  // R2b — effective base-access feature per visible package (manifest ∪ override),
  // surfaced for the Packages tab governance control.
  const accessFeatureByPackageId = new Map<string, { feature: string; source: 'manifest' | 'override' }>();
  for (const def of visibleDefinitions) {
    const override = resolveOverrideFeature(scope, def.id);
    const manifestFeature = def.requires?.accessFeature;
    if (override) accessFeatureByPackageId.set(def.id, { feature: override, source: 'override' });
    else if (manifestFeature) accessFeatureByPackageId.set(def.id, { feature: manifestFeature, source: 'manifest' });
  }

  // Enrich base package infos with loader status (partial / loaded) + reason.
  const enrichedPackages = base.packages
    .filter((pkg) => visiblePackageIds.has(pkg.id))
    .map((pkg) => {
      const af = accessFeatureByPackageId.get(pkg.id);
      const withAf = af ? { ...pkg, accessFeature: af.feature, accessFeatureSource: af.source } : pkg;
      const status = loader.getStatus(pkg.id);
      if (!status) return withAf;
      if (status.status === 'partial') {
        return { ...withAf, status: 'partial' as const, partialReason: status.reason ?? 'runtime-unavailable' };
      }
      if (status.status === 'error') {
        return {
          ...withAf,
          status: 'error' as const,
          errors: status.error ? [sanitizePackageDiagnostic(status.error)] : undefined,
        };
      }
      return withAf;
    });

  const normalizedUi = base.surfaces
    .filter((entry) => visiblePackageIds.has(entry.packageId))
    .map((entry) => normalizeUiEntry(entry, trustByPackageId))
    .filter((entry): entry is PackageRuntimeSnapshot['surfaces'][number] => entry !== null);
  const widgetsByType = new Map(
    normalizedUi
      .filter((entry): entry is WidgetRuntimeDefinition => entry.kind === 'widget')
      .map((widget) => [widget.type, widget]),
  );
  const surfaces = normalizedUi.filter((entry) => isUiEntryGranted(entry, grantedFeatures, widgetsByType));

  return {
    ...base,
    packages: enrichedPackages,
    tools: buildTools(visibleDefinitions, grantedFeatures),
    surfaces,
    commands: base.commands
      .filter((command) => visiblePackageIds.has(command.packageId))
      .filter((command) => hasRequiredFeatures(command as FeatureFiltered, grantedFeatures)),
    skills: buildContributions(visibleDefinitions, (d) => d.skills, grantedFeatures),
    instructions: buildContributions(visibleDefinitions, (d) => d.instructions, grantedFeatures),
    rules: buildContributions(visibleDefinitions, (d) => d.rules, grantedFeatures),
    agents: buildContributions(visibleDefinitions, (d) => d.agents, grantedFeatures),
    docs: buildContributions(visibleDefinitions, (d) => d.docs, grantedFeatures),
    workflows: buildWorkflows(visibleDefinitions, grantedFeatures),
    team: buildTeam(visibleDefinitions)
      .filter((member) => hasRequiredFeatures(
        { requires: { features: member.permissions?.features } },
        grantedFeatures,
      )),
    resources: visibleDefinitions.flatMap((definition) => definition.resources ?? []),
    connectors: base.connectors.filter((connector) => visiblePackageIds.has(connector.packageId)),
  };
}

export function getPackageSnapshot(scope: SnapshotScope, grantedFeatures?: string[]): PackageRuntimeSnapshot {
  return buildScopedSnapshot(scope, grantedFeatures);
}

export function getCurrentRevision(): string {
  return getService().getRevision();
}

export function isSnapshotUpToDate(clientRevision: string): boolean {
  return getService().isUpToDate(clientRevision);
}

export function getWidgetSnapshot(scope: SnapshotScope, grantedFeatures?: string[]) {
  // S-3 — thread grantedFeatures into the INNER build (uniform with
  // getDock/Command/CardSnapshot). The inner pass already filters surfaces via
  // `isUiEntryGranted` (incl. the widget↔dock-companion check), so the previous
  // outer `hasRequiredFeatures` re-filter was redundant AND under-checked.
  return buildScopedSnapshot(scope, grantedFeatures).surfaces.filter(
    (entry): entry is WidgetRuntimeDefinition => entry.kind === 'widget',
  );
}

export function getDockSnapshot(scope: SnapshotScope, grantedFeatures?: string[]) {
  return buildScopedSnapshot(scope, grantedFeatures).surfaces.filter(
    (entry): entry is DockRuntimeDefinition => entry.kind === 'dock',
  );
}

export function getCommandSnapshot(scope: SnapshotScope, grantedFeatures?: string[]): CommandRuntimeDefinition[] {
  return buildScopedSnapshot(scope, grantedFeatures).commands;
}

export function getCardSnapshot(scope: SnapshotScope, grantedFeatures?: string[]): CardRuntimeDefinition[] {
  // S2d-F — thread grantedFeatures for parity with getWidget/Dock/CommandSnapshot
  // (cards carry no `requires` today, so this is defensive consistency).
  return buildScopedSnapshot(scope, grantedFeatures).surfaces.filter(
    (entry): entry is CardRuntimeDefinition => entry.kind === 'card',
  );
}

function isUiEntryGranted(
  entry: PackageRuntimeSnapshot['surfaces'][number],
  grantedFeatures: string[] | undefined,
  widgetsByType: Map<string, WidgetRuntimeDefinition>,
): boolean {
  if (!hasRequiredFeatures(entry as FeatureFiltered, grantedFeatures)) return false;
  if (entry.kind !== 'dock' || entry.action.type !== 'open-widget') return true;
  const targetWidget = widgetsByType.get(entry.action.widget);
  return targetWidget ? hasRequiredFeatures(targetWidget, grantedFeatures) : true;
}

function sanitizePackageDiagnostic(message: string): string {
  if (!message) return 'Package runtime is unavailable';
  // Copy 3 of the FOUR-copy partial-reason union (kernel `PackagePartialReason`
  // is the source). A reason MISSING from this allow-list is silently replaced
  // by the generic string below, so the operator is told the package failed and
  // never told why — add every new reason here in the same change.
  if (
    message === 'build-missing' ||
    message === 'runtime-unavailable' ||
    message === 'untrusted-node' ||
    message === 'untrusted-mcp'
  ) return message;
  return 'Package runtime failed. Check server logs for details.';
}

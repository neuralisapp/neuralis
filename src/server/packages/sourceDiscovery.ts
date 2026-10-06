import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import {
  ExternalPackageBinder,
  validateContribution,
  validateManifest,
} from '@neuralis/package-system';
import type {
  PackageDefinition,
  PackageFile,
  PackageSourceKind,
} from '@neuralis/package-system/contracts';
import {
  normalizeSource,
  resolveLocalMounts,
  type SourceConfig,
} from '@neuralis/package-system';
import { resolveNeuralisHome, resolveProjectRoot } from '@neuralis/package-system/paths';
import { getHostIdentity } from '../host/HostIdentity';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';

/**
 * Resolve the projectRoot for the host system project. Used by package source
 * discovery to decide if a given absolute path falls inside a known mount.
 * Returns null when host identity is not yet initialized (pre-setup).
 */
function resolveHostSystemProjectRoot(): string | null {
  const roots = resolveNeuralisHome();
  try {
    const identity = getHostIdentity();
    return resolveProjectRoot(roots.projectsRoot, identity.systemProjectId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Package definition file utilities (moved from installedPackages.ts)
// ---------------------------------------------------------------------------

type AuthoringPackageJson = {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  authors?: string[];
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  keywords?: string[];
  neuralis?: Partial<PackageDefinition>;
};

function resolveDefinitionFile(
  inputPath: string,
  sourceRoot?: string,
): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error('definitionPath is required');
  }

  if (trimmed.endsWith('.json')) {
    return resolve(trimmed);
  }

  const root = sourceRoot ? resolve(sourceRoot) : resolve(trimmed);
  const packageJsonPath = resolve(root, 'package.json');
  if (existsSync(packageJsonPath)) {
    return packageJsonPath;
  }
  return resolve(root, 'neuralis.package.json');
}

function readDefinitionFromFile(path: string): PackageDefinition {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Package definition file not found: ${resolved}`);
  }

  const parsed = JSON.parse(readFileSync(resolved, 'utf-8')) as PackageDefinition | AuthoringPackageJson;
  const definition = projectDefinition(parsed);
  validatePackageDefinition(definition);
  return definition;
}

function projectDefinition(input: PackageDefinition | AuthoringPackageJson): PackageDefinition {
  if ('neuralis' in input && input.neuralis) {
    const projected: PackageDefinition = {
      id: input.neuralis.id ?? input.name ?? '',
      name: input.name ?? input.neuralis.name ?? '',
      version: input.version ?? input.neuralis.version,
      description: input.description ?? input.neuralis.description,
      authors: input.authors ?? (input.author ? [input.author] : input.neuralis.authors),
      tags: input.keywords ?? input.neuralis.tags,
      license: input.license ?? input.neuralis.license,
      homepage: input.homepage ?? input.neuralis.homepage,
      repository:
        typeof input.repository === 'string' ? input.repository : input.repository?.url ?? input.neuralis.repository,
      ...input.neuralis,
    };
    return projected;
  }

  return input as PackageDefinition;
}

export type DiscoverPackageSourceInput = {
  definition?: PackageDefinition;
  definitionPath?: string;
  sourceRoot?: string;
  source?: Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git' | 'mcp-server'>;
  gitRepository?: string;
  gitRef?: string;
  mcpServerUrl?: string;
  mcpServerName?: string;
  mcpServerAuth?: 'none' | 'api-key' | 'oauth2';
};

export type DiscoveredPackageArtifact = {
  normalizedAs: 'native-package' | 'directory-wrapper' | 'external-mcp-wrapper';
  packageId: string;
  sourceKind: PackageSourceKind;
  sourceRef?: string;
  sourceConfigPreview?: SourceConfig;
  definitionPath?: string;
  sourceRoot?: string;
  warnings: string[];
};

export type DiscoveredPackageSource = {
  definition: PackageDefinition;
  definitionPath?: string;
  sourceRoot?: string;
  artifact: DiscoveredPackageArtifact;
};

/** Max files walked per package-source scan — `sourcePackageScanMaxFiles`
 *  platform key, read once per scan (applies to newly scanned packages). */
function scanMaxFiles(): number {
  try {
    return Number(getPlatformConfigStore().get('sourcePackageScanMaxFiles')) || 200;
  } catch {
    return 200;
  }
}

type PackageSourceFile = {
  path: string;
  kind: 'manifest' | 'instruction' | 'skill' | 'rule' | 'docs';
};

export function discoverPackageSource(
  input: DiscoverPackageSourceInput,
): DiscoveredPackageSource {
  if (input.definition) {
    validatePackageDefinition(input.definition);
    return {
      definition: input.definition,
      definitionPath: input.definitionPath ? resolve(input.definitionPath) : undefined,
      sourceRoot: input.sourceRoot ? resolve(input.sourceRoot) : undefined,
      artifact: {
        normalizedAs: 'native-package',
        packageId: input.definition.id,
        sourceKind: input.definition.source?.kind ?? 'local-dir',
        sourceRef: readCanonicalSourceRef(input.definition),
        definitionPath: input.definitionPath ? resolve(input.definitionPath) : undefined,
        sourceRoot: input.sourceRoot ? resolve(input.sourceRoot) : undefined,
        warnings: [],
      },
    };
  }

  if (input.mcpServerUrl?.trim()) {
    const definition = createMcpWrapperPackage(input);
    validatePackageDefinition(definition);
    return {
      definition,
      artifact: {
        normalizedAs: 'external-mcp-wrapper',
        packageId: definition.id,
        sourceKind: definition.source?.kind ?? 'mcp-server',
        sourceRef: readCanonicalSourceRef(definition),
        warnings: [],
      },
    };
  }

  const sourceRoot = input.sourceRoot ? resolve(input.sourceRoot) : undefined;
  const definitionPath = resolveDefinitionPathIfPresent(input.definitionPath, sourceRoot);

  if (definitionPath) {
    try {
      const definition = readDefinitionFromFile(definitionPath);
      return {
        definition,
        definitionPath,
        sourceRoot,
        artifact: {
          normalizedAs: 'native-package',
          packageId: definition.id,
          sourceKind: definition.source?.kind ?? 'local-dir',
          sourceRef: readCanonicalSourceRef(definition),
          definitionPath,
          sourceRoot,
          warnings: [],
        },
      };
    } catch {
      // Definition file exists but is not a valid Neuralis package (e.g. plain
      // npm package.json without neuralis key). Fall through to directory wrapper.
    }
  }

  if (!sourceRoot) {
    throw new Error(
      'No package source found. Provide definition, definitionPath/sourceRoot with neuralis.package.json, or mcpServerUrl.',
    );
  }

  const definition = createDirectoryWrapperPackage({
    sourceRoot,
    source: input.source,
    gitRepository: input.gitRepository,
    gitRef: input.gitRef,
  });
  validatePackageDefinition(definition);
  const sourceRef = readCanonicalSourceRef(definition);

  return {
    definition,
    sourceRoot,
    artifact: {
      normalizedAs: 'directory-wrapper',
      packageId: definition.id,
      sourceKind: definition.source?.kind ?? 'local-dir',
      sourceRef,
      sourceConfigPreview: buildSourceConfigPreview(definition),
      sourceRoot,
      warnings: [
        'Installed source has no neuralis.package.json; a synthetic wrapper package was generated.',
      ],
    },
  };
}

export function findPackageRootForPath(
  filePath: string,
  watchRoot?: string,
): string | null {
  let current = resolve(filePath);
  const normalizedWatchRoot = watchRoot ? resolve(watchRoot) : undefined;

  if (!existsSync(current) && normalizedWatchRoot) {
    current = resolve(current, '..');
  }

  while (true) {
    if (hasPackageManifest(current)) {
      return current;
    }

    if (normalizedWatchRoot && current === normalizedWatchRoot) {
      return null;
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function hasPackageManifest(sourceRoot: string): boolean {
  if (!existsSync(sourceRoot)) {
    return false;
  }

  // Explicit manifest files
  if (existsSync(resolve(sourceRoot, 'neuralis.package.json'))) return true;
  if (existsSync(resolve(sourceRoot, 'package.json'))) return true;

  // Content-based markers — directories with known AI package structures
  const contentMarkers = [
    'skills', 'agents', 'rules', 'commands', 'hooks', 'guidances',
    '.claude', '.gemini', '.cursor',
    'SKILL.md', 'AGENTS.md', 'CLAUDE.md',
  ];
  return contentMarkers.some((marker) => existsSync(resolve(sourceRoot, marker)));
}

function resolveDefinitionPathIfPresent(
  definitionPath?: string,
  sourceRoot?: string,
): string | undefined {
  const candidate = definitionPath?.trim() || sourceRoot?.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const resolved = resolveDefinitionFile(candidate, sourceRoot);
    return existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function createMcpWrapperPackage(input: DiscoverPackageSourceInput): PackageDefinition {
  const binder = new ExternalPackageBinder();
  const definition = binder.createSyntheticPackage({
    url: input.mcpServerUrl!.trim(),
    name: input.mcpServerName?.trim() || undefined,
    auth: input.mcpServerAuth ?? 'none',
  });

  return {
    ...definition,
    source: {
      ...(definition.source ?? { kind: 'mcp-server' as const }),
      raw: {
        ...(definition.source?.raw ?? {}),
        canonicalSourceRef: undefined,
        sourceAdapter: 'external-mcp-wrapper',
      },
    },
    meta: {
      ...definition.meta,
      hosts: [
        'neuralis-server',
        'neuralis-workspace',
      ],
      extensions: {
        ...definition.meta?.extensions,
        sourceDiscovery: {
          sourceAdapter: 'external-mcp-wrapper',
        },
      },
    },
  };
}

function createDirectoryWrapperPackage(params: {
  sourceRoot: string;
  source?: DiscoverPackageSourceInput['source'];
  gitRepository?: string;
  gitRef?: string;
}): PackageDefinition {
  const sourceRoot = resolve(params.sourceRoot);
  if (!existsSync(sourceRoot)) {
    throw new Error(`sourceRoot does not exist: ${sourceRoot}`);
  }

  const sourceKind = inferSourceKind(sourceRoot, params.source, params.gitRepository);
  const sourceDescriptor = describeCanonicalSource(sourceRoot, sourceKind, params.gitRepository);
  const sourceFiles = scanSourceFiles(sourceRoot);
  const packageId = buildDirectoryPackageId(sourceRoot, sourceKind, params.gitRepository);
  const name = buildDirectoryPackageName(sourceRoot, sourceKind, params.gitRepository);

  return {
    source: {
      kind: sourceKind,
      location: {
        path: sourceRoot,
        git: params.gitRepository,
        ref: params.gitRef,
      },
      raw: {
        wrapper: true,
        wrappedAt: Date.now(),
        fileCount: sourceFiles.length,
        files: sourceFiles,
        canonicalSourceRef: sourceDescriptor.sourceRef,
        sourceRootRelativeToSourceRef: sourceDescriptor.relativeRoot,
        sourceAdapter: 'directory-wrapper',
      },
    },
    id: packageId,
    name,
    version: '0.0.0',
    description: `Synthetic wrapper package for ${sourceKind} source at ${sourceRoot}`,
    tags: ['synthetic', sourceKind],
    ...partitionContributionsByCategory(sourceFiles.map((f) => toRuntimeFile(f, sourceRoot))),
    runtime: {
      binding: 'none',
      hosted: {
        tools: 'none',
        prompts: 'none',
        resources: 'none',
      },
    },
    access: {
      externalPolicy: 'allow',
      trust: sourceKind === 'git' ? 'untrusted' : 'trusted',
    },
    meta: {
      hosts: ['neuralis-server', 'neuralis-workspace'],
      families: ['source-wrapper'],
      distribution: {
        installRoot: sourceRoot,
        gitRepository: params.gitRepository,
        gitRef: params.gitRef,
      },
      extensions: {
        syntheticWrapper: true,
        sourceDiscovery: {
          sourceRef: sourceDescriptor.sourceRef,
          relativeRoot: sourceDescriptor.relativeRoot,
          sourceAdapter: 'directory-wrapper',
          sourceConfigPreview: sourceDescriptor.sourceConfigPreview,
        },
      },
    },
  };
}

function inferSourceKind(
  sourceRoot: string,
  explicitSource?: DiscoverPackageSourceInput['source'],
  gitRepository?: string,
): Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git'> {
  if (explicitSource && explicitSource !== 'mcp-server') {
    return explicitSource;
  }
  if (gitRepository) {
    return 'git';
  }

  const projectRoot = resolveHostSystemProjectRoot();
  if (projectRoot) {
    const mounts = resolveLocalMounts(process.env, projectRoot);
    for (const [mountKey, mountRoot] of mounts) {
      const normalizedMountRoot = resolve(mountRoot);
      if (sourceRoot === normalizedMountRoot || sourceRoot.startsWith(`${normalizedMountRoot}/`)) {
        return mountKey === 'data' ? 'local-dir' : 'mounted-dir';
      }
    }
  }

  return 'local-dir';
}

type CanonicalSourceDescriptor = {
  sourceRef?: string;
  relativeRoot?: string;
  sourceConfigPreview?: SourceConfig;
};

function describeCanonicalSource(
  sourceRoot: string,
  sourceKind: Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git'>,
  gitRepository?: string,
): CanonicalSourceDescriptor {
  if (sourceKind === 'git') {
    const githubRepo = toGitHubRepo(gitRepository);
    if (!githubRepo) {
      return {};
    }
    const sourceRef = normalizeSource(`github:${githubRepo}`);
    const now = new Date().toISOString();
    return {
      sourceRef,
      sourceConfigPreview: {
        source: sourceRef,
        connection: { kind: 'github', repo: githubRepo },
        permissions: { default: { read: true, write: false, exec: false } },
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const projectRoot = resolveHostSystemProjectRoot();
  if (!projectRoot) {
    return { sourceRef: undefined, relativeRoot: undefined, sourceConfigPreview: undefined };
  }
  const mounts = resolveLocalMounts(process.env, projectRoot);
  for (const [mountKey, mountRoot] of mounts) {
    const normalizedMountRoot = resolve(mountRoot);
    if (sourceRoot === normalizedMountRoot || sourceRoot.startsWith(`${normalizedMountRoot}/`)) {
      const sourceRef = mountKey;
      const relativeRoot = relative(normalizedMountRoot, sourceRoot) || '.';
      const now = new Date().toISOString();
      return {
        sourceRef,
        relativeRoot,
        sourceConfigPreview: {
          source: sourceRef,
          connection: { kind: 'local', root: normalizedMountRoot },
          permissions: { default: { read: true, write: mountKey === 'main', exec: false } },
          createdAt: now,
          updatedAt: now,
        },
      };
    }
  }

  return {};
}

function scanSourceFiles(sourceRoot: string): PackageSourceFile[] {
  const files: PackageSourceFile[] = [];
  const maxScannedFiles = scanMaxFiles();

  const visit = (dir: string) => {
    if (files.length >= maxScannedFiles) {
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxScannedFiles) {
        return;
      }
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      const absolutePath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      files.push({
        path: relative(sourceRoot, absolutePath),
        kind: inferSourceFileKind(entry.name),
      });
    }
  };

  const stats = statSync(sourceRoot);
  if (!stats.isDirectory()) {
    throw new Error(`sourceRoot must be a directory: ${sourceRoot}`);
  }

  visit(sourceRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function inferSourceFileKind(filename: string): PackageSourceFile['kind'] {
  const lower = filename.toLowerCase();
  if (lower === 'neuralis.package.json') return 'manifest';
  if (lower === 'package.json') return 'manifest';
  if (lower.includes('instruction')) return 'instruction';
  if (lower.includes('skill')) return 'skill';
  if (lower.includes('rule')) return 'rule';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'docs';
  return 'docs';
}

/** Max inline content per file (KB) — `sourcePackageInlineMaxKb` platform key,
 *  read per scanned file (applies to newly scanned packages). Caps how much a
 *  single discovered file can feed into prompt injection. */
function inlineMaxKb(): number {
  try {
    return Number(getPlatformConfigStore().get('sourcePackageInlineMaxKb')) || 64;
  } catch {
    return 64;
  }
}

/** Categories whose content is worth loading inline for prompt injection. */
const INLINE_LOADABLE_CATEGORIES = new Set<PackageFile['category']>([
  'instruction', 'rule', 'skill', 'agent', 'docs',
]);

function toRuntimeFile(file: PackageSourceFile, sourceRoot: string): PackageFile {
  const category = toFileCategory(file.kind);
  const result: PackageFile = {
    id: file.path.replace(/[^a-zA-Z0-9._/-]+/g, '-'),
    path: file.path,
    title: basename(file.path),
    category,
    metadata: {
      discovered: true,
    },
  };

  // Load inline content for text categories used in prompt injection
  if (INLINE_LOADABLE_CATEGORIES.has(category)) {
    const absolutePath = resolve(sourceRoot, file.path);
    try {
      if (existsSync(absolutePath)) {
        const maxKb = inlineMaxKb();
        const maxInlineContent = maxKb * 1024;
        let content = readFileSync(absolutePath, 'utf8');
        if (content.length > maxInlineContent) {
          content = content.slice(0, maxInlineContent) + `\n[...truncated at ${maxKb}KB]`;
        }
        result.content = content;
      }
    } catch {
      // Binary or unreadable — skip content
    }
  }

  return result;
}

/** Split discovered contributions into the five first-class category arrays. */
function partitionContributionsByCategory(contributions: PackageFile[]): {
  skills: PackageFile[];
  instructions: PackageFile[];
  rules: PackageFile[];
  agents: PackageFile[];
  docs: PackageFile[];
} {
  const out = { skills: [] as PackageFile[], instructions: [] as PackageFile[], rules: [] as PackageFile[], agents: [] as PackageFile[], docs: [] as PackageFile[] };
  for (const c of contributions) {
    switch (c.category) {
      case 'skill': out.skills.push(c); break;
      case 'instruction': out.instructions.push(c); break;
      case 'rule': out.rules.push(c); break;
      case 'agent': out.agents.push(c); break;
      default: out.docs.push(c); break;
    }
  }
  return out;
}

function toFileCategory(kind: PackageSourceFile['kind']): PackageFile['category'] {
  switch (kind) {
    case 'manifest':
      return 'docs';
    case 'instruction':
      return 'instruction';
    case 'skill':
      return 'skill';
    case 'rule':
      return 'rule';
    default:
      return 'docs';
  }
}

function buildDirectoryPackageId(
  sourceRoot: string,
  sourceKind: Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git'>,
  gitRepository?: string,
): string {
  if (sourceKind === 'git' && gitRepository) {
    return `source:${slugify(gitRepository)}`;
  }
  return `source:${sourceKind}:${slugify(sourceRoot)}`;
}

function buildDirectoryPackageName(
  sourceRoot: string,
  sourceKind: Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git'>,
  gitRepository?: string,
): string {
  if (sourceKind === 'git' && gitRepository) {
    return `Git Source: ${gitRepository}`;
  }
  const suffix = extname(sourceRoot) ? basename(sourceRoot, extname(sourceRoot)) : basename(sourceRoot);
  return `${sourceKind === 'mounted-dir' ? 'Mounted' : 'Local'} Source: ${suffix || sourceRoot}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[/:]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readCanonicalSourceRef(definition: PackageDefinition): string | undefined {
  const raw = definition.source?.raw;
  if (raw && typeof raw.canonicalSourceRef === 'string' && raw.canonicalSourceRef.trim()) {
    return normalizeSource(raw.canonicalSourceRef);
  }
  const metaSourceRef = definition.meta?.extensions?.sourceDiscovery;
  if (
    metaSourceRef
    && typeof metaSourceRef === 'object'
    && typeof (metaSourceRef as { sourceRef?: unknown }).sourceRef === 'string'
  ) {
    return normalizeSource((metaSourceRef as { sourceRef: string }).sourceRef);
  }
  return undefined;
}

function buildSourceConfigPreview(definition: PackageDefinition): SourceConfig | undefined {
  const extension = definition.meta?.extensions?.sourceDiscovery;
  if (!extension || typeof extension !== 'object') {
    return undefined;
  }
  const preview = (extension as { sourceConfigPreview?: unknown }).sourceConfigPreview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return undefined;
  }
  return preview as SourceConfig;
}

function toGitHubRepo(gitRepository?: string): string | undefined {
  const trimmed = gitRepository?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return trimmed.replace(/\.git$/i, '');
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.includes('github.com')) {
      return undefined;
    }
    return parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '') || undefined;
  } catch {
    return undefined;
  }
}

function validatePackageDefinition(definition: PackageDefinition): void {
  const manifestValidation = validateManifest(definition);
  if (manifestValidation.errors.length > 0) {
    throw new Error(`Invalid package definition: ${manifestValidation.errors.join('; ')}`);
  }

  const contributionValidation = validateContribution(definition);
  if (contributionValidation.errors.length > 0) {
    throw new Error(`Invalid package content: ${contributionValidation.errors.join('; ')}`);
  }
}

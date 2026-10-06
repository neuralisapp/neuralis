/**
 * Feature catalog derived from builtin package manifests.
 *
 * Separate from bootstrap.ts to avoid circular imports:
 * bootstrap → ProjectStore → projectTypes → builtinFeatures (no cycle)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageDefinition, PackageRequires } from '@neuralis/package-system/contracts';
import { collectAllFeatures, mergeDefaultRoleGrants } from '@neuralis/package-system';
import { BUILTIN_PACKAGE_IDS, resolveBuiltinRoot } from './builtinSlots';

// ---------------------------------------------------------------------------
// Feature catalog
// ---------------------------------------------------------------------------

function readPackageRequires(packageRoot: string): PackageRequires | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
    return raw.neuralis?.requires;
  } catch {
    return undefined;
  }
}

let _builtinRequires: Pick<PackageDefinition, 'requires'>[] | undefined;

function getBuiltinRequires(): Pick<PackageDefinition, 'requires'>[] {
  if (!_builtinRequires) {
    _builtinRequires = [...BUILTIN_PACKAGE_IDS].map(id => ({ requires: readPackageRequires(resolveBuiltinRoot(id)) }));
  }
  return _builtinRequires;
}

/** All features declared by builtin packages via requires.providesFeatures. */
export function getFirstPartyFeatures(): string[] {
  return collectAllFeatures(getBuiltinRequires());
}

/** Default role → feature grants merged from all builtin packages. */
export function getDefaultRoleFeatures(): Record<string, string[]> {
  return mergeDefaultRoleGrants(getBuiltinRequires());
}

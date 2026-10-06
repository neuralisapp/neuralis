/**
 * The custom-endpoint config row used to live in FIVE hand-written copies, and
 * they had already drifted.
 *
 * The kernel owns the shape (`LlmEndpointEntry` = the operator-endpoint
 * envelope + the LLM extras, `package-system/src/contracts/endpoints.ts`;
 * agent-core's `LocalLLMEntry` is an alias of it). The setup wizard still
 * carries its own structural view — and nothing held it to reality. The
 * measured consequence of such a copy: the write route's `validate()` silently
 * DISCARDED `keepAlive`, a field `getLocalProviders` reads and the Ollama
 * stream honours, so the platform's only editing surface could not round-trip
 * one of the runtime's own fields. A type could not see it, because there was
 * no shared type.
 *
 * Derive-and-verify closes it the way `packages/admin/test/agentCoreApiContract.test.ts`
 * does: read the kernel's BUILT declaration off disk by absolute path and
 * compare KEY SETS.
 *
 * The comparison is asymmetric ON PURPOSE, per copy:
 *  - the host STORE carries no copy at all (no host code reads the list) — and
 *    must not grow one back;
 *  - the WRITER (admin's endpoint-list usecase) carries no shape either — it
 *    delegates to the kernel's `parseOperatorEndpoints` — so what is pinned is
 *    exactly that: it must contain NO second field table;
 *  - the WIZARD writes a SUBSET (a first-run CLI cannot ask about every
 *    field), so its keys must be a subset of the owner's — never a superset,
 *    which would mean it writes a field nothing reads.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const KERNEL_ENDPOINT_TYPES = join(REPO, 'packages/package-system/dist/src/contracts/endpoints.d.ts');
const HOST_STORE = join(REPO, 'neuralis/src/server/store/PlatformConfigStore.ts');
const ENDPOINT_WRITER = join(REPO, 'packages/admin/src/usecases/operatorEndpointList.ts');
const SETUP_TYPES = join(REPO, 'neuralis/scripts/setup/types.mts');

/**
 * Keys of ONE `type X = { … }` block, read as source text.
 *
 * A TEXT read rather than a TS program because three of the four files are not
 * in one program (a `.mts` CLI, a built `.d.ts`, host sources) — and the thing
 * that drifts is the FIELD SET, which text answers exactly.
 */
function typeKeys(file: string, typeName: string): string[] {
  const source = readFileSync(file, 'utf-8');
  // `type Name = {` or a generic `type Name<M, K …> = {`.
  const start = source.search(new RegExp(`type ${typeName}(<.*?>)? = \\{`));
  expect(start, `${typeName} not found in ${file} — did it move or get renamed?`).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `unbalanced braces reading ${typeName} from ${file}`).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const keys = new Set<string>();
  // Only TOP-level members: a nested object literal's own keys are that
  // member's business, and counting them would make the sets incomparable.
  let nested = 0;
  for (const line of body.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (nested === 0) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(trimmed);
      if (match) keys.add(match[1]);
    }
    nested += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (nested < 0) nested = 0;
  }
  return [...keys].sort();
}

describe('custom-endpoint entry shape — the host copies follow the kernel', () => {
  const owner = [
    ...typeKeys(KERNEL_ENDPOINT_TYPES, 'OperatorEndpointEntry'),
    ...typeKeys(KERNEL_ENDPOINT_TYPES, 'LlmEndpointExtras'),
  ].sort();

  it('the owning declaration is actually readable (non-vacuity)', () => {
    // Without this the whole file passes trivially the day the build output
    // moves — every set would be empty and every subset assertion would hold.
    expect(owner.length).toBeGreaterThan(5);
    expect(owner).toContain('keepAlive');
    expect(owner).toContain('auth');
  });

  it('the host store carries NO copy of the entry — no host code reads the list', () => {
    const source = readFileSync(HOST_STORE, 'utf-8');
    expect(source).not.toMatch(/type\s+LocalLLM\w*\s*=/);
    expect(source).not.toMatch(/\blocalLLMs\s*:/);
  });

  it('the setup wizard writes a SUBSET — never a field nothing reads', () => {
    const wizard = typeKeys(SETUP_TYPES, 'LocalLLMEntry');
    expect(wizard.length).toBeGreaterThan(0);
    expect(wizard.filter((key) => !owner.includes(key))).toEqual([]);
  });

  it('the endpoint-list writer carries NO field table of its own', () => {
    // Validation is the kernel's `parseOperatorEndpoints` over the family's
    // shape. A re-inlined local shape here is the regression this file exists
    // to catch — it is how `keepAlive` was dropped in the first place.
    const source = readFileSync(ENDPOINT_WRITER, 'utf-8');
    expect(source).toContain('parseOperatorEndpoints');
    expect(source).not.toMatch(/type\s+LocalLLMEntry\s*=\s*\{/);
    expect(source).not.toMatch(/function\s+validate\s*\(/);
  });
});

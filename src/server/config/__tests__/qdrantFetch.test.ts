/**
 * Host-side Qdrant auth oracle (R-1).
 *
 * `pnpm reset:vector` is the PUBLICLY documented recovery for an embedding
 * dimension-lock mismatch (`web/docs/.../brain-core/memory-and-sync.mdx`). Both
 * of its Qdrant calls — the collection LIST and the destructive DELETE — hit
 * endpoints Qdrant protects with `api-key`, and the script swallows the 401
 * into a generic "Qdrant error" line before continuing with the lock/cache
 * cleanup. The operator sees a green-looking run that dropped nothing.
 *
 * Two properties are pinned here:
 *   (a) the helper sends the lowercase `api-key` header when `QDRANT_API_KEY`
 *       is set, and NO auth header at all when it is unset or blank;
 *   (b) a STATIC drift guard: `scripts/reset-vector.mts` contains ZERO bare
 *       `fetch(` calls. This is the half that catches a FUTURE call site added
 *       with a raw `fetch` — the unit half cannot see one.
 *
 * The mirror-image floor lives with the admin copy
 * (`packages/admin/test/qdrantAuth.test.ts` case (c)): the key must NEVER reach
 * a non-Qdrant host. `scripts/setup/detect.mts` sends ONE header-free `httpGet`
 * (`node:http`, not `fetch`) to BOTH the Qdrant probe and the Ollama probe, so
 * a key added there would leak to a different service — guard (c) below pins
 * that the sharing is real and that no key reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { qdrantAuthHeaders, qdrantFetch } from '../qdrantFetch';

const ORIGINAL_ENV = { ...process.env };
const API_KEY = 'sk-qdrant-host-test-key';

type Recorded = { url: string; method: string; headers: Headers };

const AUTH_HEADER_NAMES = ['api-key', 'authorization', 'x-api-key'] as const;

function authHeadersOf(c: Recorded): string[] {
  return AUTH_HEADER_NAMES.filter((name) => c.headers.has(name));
}

function installFetchRecorder(): Recorded[] {
  const calls: Recorded[] = [];
  global.fetch = vi.fn(async (input: any, init?: any) => {
    calls.push({
      url: String(input),
      method: (init?.method as string | undefined) ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return new Response('{}', { status: 200 });
  }) as any;
  return calls;
}

function readScript(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../scripts/${relative}`, import.meta.url)), 'utf-8');
}

/** Bare `fetch(` calls — `qdrantFetch(` and `.fetch(` do not match. */
function countBareFetchCalls(source: string): number {
  return source.match(/(?<![A-Za-z0-9_$.])fetch\s*\(/g)?.length ?? 0;
}

describe('host qdrantFetch', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.QDRANT_API_KEY;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // ---------------------------------------------------------------------
  // (a) the helper itself
  // ---------------------------------------------------------------------

  it('sends the lowercase `api-key` header when QDRANT_API_KEY is set', async () => {
    process.env.QDRANT_API_KEY = API_KEY;
    const calls = installFetchRecorder();
    await qdrantFetch('http://qdrant.test/collections');
    expect(calls[0]!.headers.get('api-key')).toBe(API_KEY);
    expect(qdrantAuthHeaders()).toEqual({ 'api-key': API_KEY });
  });

  it('sends NO auth header when the var is unset', async () => {
    const calls = installFetchRecorder();
    await qdrantFetch('http://qdrant.test/collections');
    expect(authHeadersOf(calls[0]!)).toEqual([]);
    expect(qdrantAuthHeaders()).toEqual({});
  });

  it('sends NO auth header for a blank / whitespace-only value', async () => {
    process.env.QDRANT_API_KEY = '   ';
    const calls = installFetchRecorder();
    await qdrantFetch('http://qdrant.test/collections');
    expect(authHeadersOf(calls[0]!)).toEqual([]);
    expect(qdrantAuthHeaders()).toEqual({});
  });

  it('preserves caller init (method + headers) while adding the key — the DESTRUCTIVE shape', async () => {
    process.env.QDRANT_API_KEY = API_KEY;
    const calls = installFetchRecorder();
    await qdrantFetch('http://qdrant.test/collections/neuralis_mcp_nodes', {
      method: 'DELETE',
      headers: { 'x-trace': 'abc' },
    });
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.headers.get('api-key')).toBe(API_KEY);
    expect(calls[0]!.headers.get('x-trace')).toBe('abc');
  });

  it('reads LIVE per call — no module-level capture', async () => {
    const calls = installFetchRecorder();
    await qdrantFetch('http://qdrant.test/collections');
    expect(authHeadersOf(calls[0]!)).toEqual([]);

    process.env.QDRANT_API_KEY = API_KEY;
    await qdrantFetch('http://qdrant.test/collections');
    expect(calls[1]!.headers.get('api-key')).toBe(API_KEY);
  });

  // ---------------------------------------------------------------------
  // (b) static drift guard over the SCRIPT
  // ---------------------------------------------------------------------

  it('scripts/reset-vector.mts makes ZERO bare fetch() calls', () => {
    const source = readScript('reset-vector.mts');
    expect(source).toContain("from '../src/server/config/qdrantFetch'");
    expect(countBareFetchCalls(source)).toBe(0);
    // Both Qdrant surfaces go through the helper — the list AND the DELETE.
    expect(source).toContain('await qdrantFetch(`${url}/collections`)');
    expect(source).toContain("method: 'DELETE'");
  });

  // ---------------------------------------------------------------------
  // (c) the mirror floor — detect.mts must NOT gain the header
  // ---------------------------------------------------------------------

  it('scripts/setup/detect.mts keeps its SHARED httpGet key-free (Ollama leak floor)', () => {
    const source = readScript('setup/detect.mts');
    expect(source).not.toContain('qdrantFetch');
    expect(source).not.toContain('api-key');
    // It really is ONE shared helper — the same `httpGet` answers the Qdrant
    // health probe and the Ollama tag probe, which is why it must stay header-free.
    expect(source).toContain('function httpGet(');
    expect(source).toContain('await httpGet(`${url}/healthz`)');
    expect(source).toContain('await httpGet(`${url}/api/tags`)');
    // …and it is not `fetch` at all: `node:http`, which carries no default headers.
    expect(countBareFetchCalls(source)).toBe(0);
  });
});

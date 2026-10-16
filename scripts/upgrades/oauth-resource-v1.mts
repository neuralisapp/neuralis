/**
 * Offline upgrade `oauth-resource-v1`: agent-core's inbound OAuth refresh-grant
 * store (`agent-core/oauth-tokens`, v1 → v2).
 *
 * The authorization server now serves two resources — the MCP endpoint and the
 * host API — and every grant is BOUND to one of them: the token endpoint
 * refuses a refresh whose grant names another resource, and a grant with no
 * stored `resource` matches nothing at all (the runtime never guesses one).
 * Every grant written before this build was issued for MCP, the only resource
 * there was, so this upgrade stamps the MCP resource on each one — the value
 * the running server computes, `<MCP_BASE_URL>/mcp` (`src/server/mcp/mcpBaseUrl.ts`,
 * the one derivation) — and changes nothing else: hash, expiry, status and
 * revocation stay byte-for-byte what they were.
 *
 * The FILE is `<home>/app/config/oauth/tokens.json`. Nothing in the repository
 * reads the ledger; the kind ↔ file binding is a convention, written down as
 * the kind's `files` in agent-core's `store/dataFormats.ts` and relied on here.
 *
 * The census validates the CONTAINER, never drops a row: a file that is not a
 * token store at all blocks (the runtime would refuse it too); a record that is
 * not a usable grant is kept VERBATIM and named in the summary — the runtime
 * keeps such a record too and it never matches. Idempotent: a stamped record
 * no longer matches. The command around this module owns the rest: the strict
 * dry run, the refusal while the app runs, and the checkpoint (the backup)
 * before any write.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { resolveMcpBaseUrl } from '../../src/server/mcp/mcpBaseUrl';

const KIND = 'agent-core/oauth-tokens';
const TO = 2;
const REMEDY = 'the token store is not readable as a token store: restore it from a backup (or a checkpoint), or move it aside — every MCP client then signs in again';

type Json = Record<string, unknown>;

type Census = { path: string; rel: string; stamped: number; unusable: number; already: number; next: string | null; blockers: string[]; resource: string };

/** The MCP resource the running server binds new grants to — `buildOAuthConfig`'s `${issuer}/mcp`. */
export function mcpResource(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return `${resolveMcpBaseUrl(env)}/mcp`;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A record the repository could ever match: the fields a lookup reads. */
function usable(record: Json): boolean {
  return typeof record.id === 'string' && typeof record.tokenHash === 'string' && typeof record.clientId === 'string' && typeof record.userId === 'string';
}

export async function census(ctx: Pick<OfflineUpgradeContext, 'home' | 'appRoot'>, resource = mcpResource()): Promise<Census> {
  const path = join(ctx.appRoot, 'config', 'oauth', 'tokens.json');
  const rel = relative(ctx.home, path);
  const out: Census = { path, rel, stamped: 0, unusable: 0, already: 0, next: null, blockers: [], resource };
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    out.blockers.push(`${rel} · not valid JSON`);
    return out;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.tokens) || !parsed.tokens.every(isObject)) {
    out.blockers.push(`${rel} · not a token store (expected {"tokens":[{…}]})`);
    return out;
  }
  const tokens = (parsed.tokens as Json[]).map((record) => {
    if (typeof record.resource === 'string' && record.resource.length > 0) {
      out.already += 1;
      return record;
    }
    if (!usable(record)) {
      out.unusable += 1;
      return record; // kept verbatim: never dropped, never matched
    }
    out.stamped += 1;
    return { ...record, resource };
  });
  if (out.stamped > 0) out.next = JSON.stringify({ ...parsed, tokens }, null, 2);
  return out;
}

function plan(c: Census): OfflineUpgradePlan {
  const summary = [
    c.stamped + c.already + c.unusable === 0
      ? 'oauth grants: none stored'
      : `oauth grants: ${c.stamped} bound to ${c.resource}, ${c.already} already bound`,
  ];
  if (c.unusable > 0) summary.push(`oauth grants: ${c.unusable} record(s) are not usable grants — kept unchanged, they match nothing (as before)`);
  return {
    files: c.next !== null || c.blockers.length > 0 ? [c.rel] : [],
    summary,
    ...(c.blockers.length > 0 ? { blockers: { lines: c.blockers, remedy: REMEDY } } : {}),
  };
}

export default {
  id: 'oauth-resource-v1',
  kinds: [{ kind: KIND, to: TO }],
  dryRun: async (ctx) => plan(await census(ctx)),
  async apply(ctx) {
    const c = await census(ctx);
    if (c.blockers.length > 0) throw new Error(`oauth-resource-v1: ${c.blockers.join('; ')} — ${REMEDY}`);
    if (c.next === null) return; // nothing older left (fresh store, or a resumed run)
    await durableReplaceFile(c.path, `${c.next}\n`, { mode: 0o600 });
    ctx.log(`${c.rel}: ${c.stamped} grant(s) bound to ${c.resource}`);
  },
} satisfies OfflineUpgradeModule;

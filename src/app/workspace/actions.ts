'use server';

/**
 * Workspace Server Actions.
 *
 * ## Why this action authenticates itself
 *
 * A Server Action is its OWN entry point. It does NOT inherit the
 * `getSessionUser()` → `redirect('/auth')` gate in `workspace/page.tsx`: the
 * page guard runs on a GET render, while an action is reached by POSTing the
 * action id to the same route. Next.js states this directly for our pinned
 * version — "Never assume any authentication claims at the `use cache` or
 * `use server` boundary. Always authenticate within the boundary."
 *
 * Without the in-boundary check, a caller holding only the action id and NO
 * cookie received the full SSR runtime snapshot: skill descriptions with their
 * verbatim `SKILL.md` bodies, agents, rules, instructions, docs, widget/dock/
 * card surfaces and every loaded package id. `getSSRSnapshot()` passes `[]`
 * grantedFeatures, so S2-gated contributions were already excluded — the leak
 * was bounded to ungated ones, which is why this is a disclosure rather than an
 * escalation. It is still a disclosure.
 *
 * Do NOT "simplify" the `requireSession()` call back out on the grounds that
 * `page.tsx` already checks. It does not cover this boundary.
 */

import { requireSession } from '@/server/auth/session';
import { getSSRSnapshot } from '@/server/packages/snapshotForSSR';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';

export async function refreshSnapshot(): Promise<PackageRuntimeSnapshot> {
  // Throws `Unauthorized` when there is no session. Deliberately a throw and
  // not a `null` return: the return type is non-nullable and widening it would
  // ripple into `WorkspaceRoot`, which already swallows a rejection here.
  await requireSession();
  return getSSRSnapshot();
}

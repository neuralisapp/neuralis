/**
 * InviteStore — the pending invite LINKS, one file per link under
 * `<appRoot>/invites/<sha256(token)>.json`.
 *
 * The token itself is never stored: the record's key IS its SHA-256 (hex), so
 * a redeem is ONE keyed read and the directory listing names nothing a caller
 * could present. A link is single use by construction — {@link claimInvite}
 * stamps `claimedAt` and a random `claimId` INSIDE the store's per-record write
 * chain, so of two concurrent redeems exactly one finds its own `claimId`; the other reads a claimed
 * record and is refused like an unknown token. A redeemed or revoked link is
 * DELETED; an expired one is dropped by the next {@link listInvites} sweep, so
 * the directory holds pending links only.
 *
 * `globalThis`-anchored like `UserStore` / `ProjectStore`: the admin port
 * (bootstrap graph) issues and the redeem route (route graph) reads, and a
 * per-graph `FileStore` would be a per-graph chain — two redeems in two graphs
 * would each see an unclaimed record. No read cache: a cached "unclaimed" read
 * is exactly the window single use must not have.
 */

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { FileStore } from './FileStore';
import { getEnv } from '../config/env';
import { ensureHostDataFormat, HOST_DATA_FORMATS } from './dataFormats';

export type InviteRecord = {
  /** `sha256(token)` hex — the record key. */
  id: string;
  /** The public handle a list or a revoke names (random, never derived from the token). */
  inviteId: string;
  projectId: string;
  role: string;
  /** Lower-cased, trimmed — the same normalization `UserStore` keys accounts on. */
  email: string;
  inviterUserId: string;
  createdAt: string;
  expiresAt: string;
  /** Set by the ONE redeem that won the claim; a claimed record is never redeemable again. */
  claimedAt?: string;
  /**
   * The winning claim's random nonce. The WIN test compares this, never the
   * time: two redeems in one millisecond share a timestamp, and a time
   * compare let both of them win.
   */
  claimId?: string;
};

/** A claim left behind by a redeem that died mid-way is swept after this long. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

const STORE_SLOT = Symbol.for('@neuralis/host:inviteStore');

function getStore(): FileStore<InviteRecord> {
  const g = globalThis as { [STORE_SLOT]?: FileStore<InviteRecord> };
  return (g[STORE_SLOT] ??= new FileStore<InviteRecord>(join(getEnv().appRoot, 'invites')));
}

async function claimedStore(): Promise<FileStore<InviteRecord>> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.invite);
  return getStore();
}

/** The record key for a presented token. */
export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function putInvite(record: InviteRecord): Promise<void> {
  await (await claimedStore()).put(record.id, record);
}

/** The record for a presented token, or `null` (never a throw for an unknown one). */
export async function getInviteByToken(token: string): Promise<InviteRecord | null> {
  return (await claimedStore()).get(inviteTokenHash(token));
}

/**
 * Claim the link for ONE redeem. Answers the claimed record only when THIS call
 * stamped it — unclaimed, unexpired, in the chain — and `null` otherwise.
 */
export async function claimInvite(token: string, now: Date = new Date()): Promise<InviteRecord | null> {
  const claimId = randomBytes(12).toString('base64url');
  const after = await (await claimedStore()).update(inviteTokenHash(token), (current) => {
    if (!current || current.claimedAt || Date.parse(current.expiresAt) <= now.getTime()) return undefined;
    return { ...current, claimedAt: now.toISOString(), claimId };
  });
  return after && after.claimId === claimId ? after : null;
}

/** Give a claim back (the redeem failed on the invitee's side, never on authority). */
export async function releaseInviteClaim(record: InviteRecord): Promise<void> {
  await (await claimedStore()).update(record.id, (current) => {
    if (!current || current.claimId === undefined || current.claimId !== record.claimId) return undefined;
    const { claimedAt: _claimedAt, claimId: _claimId, ...rest } = current;
    return rest;
  });
}

export async function deleteInvite(record: Pick<InviteRecord, 'id'>): Promise<boolean> {
  return (await claimedStore()).delete(record.id);
}

/**
 * The project's pending links, oldest first. Sweeps as it reads: an expired
 * record and a claim older than {@link STALE_CLAIM_MS} are deleted — the
 * store's whole retention, no timer.
 */
export async function listInvites(projectId: string, now: Date = new Date()): Promise<InviteRecord[]> {
  const store = await claimedStore();
  const all = await store.list();
  const pending: InviteRecord[] = [];
  for (const record of all) {
    const expired = Date.parse(record.expiresAt) <= now.getTime();
    const staleClaim = record.claimedAt !== undefined && Date.parse(record.claimedAt) <= now.getTime() - STALE_CLAIM_MS;
    if (expired || staleClaim) {
      await store.delete(record.id);
      continue;
    }
    if (record.projectId === projectId && record.claimedAt === undefined) pending.push(record);
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Invite LINKS — a one-time, expiring, revocable link bound to ONE project, ONE
 * role and ONE email. The person it was made for opens `<appOrigin>/invite#t=…`
 * and either creates their account with their own password or, holding an
 * account already, joins with it. No password crosses chat or the admin's
 * screen, and an existing user can be invited at all.
 *
 * Two sides, one floor:
 *
 * - **issue / list / revoke** — the governance port's link verbs (the admin
 *   package's `invite-links` route: the Users tab and the invite skill). Scalar
 *   caller identity; the floor is {@link checkInviteFloor} on the LIVE record
 *   (`canInvite` + the role no stronger than the caller's), exactly as
 *   `inviteUserToProject` derives it. `via` is audit provenance, never an
 *   authority. An agent may mint a link (owner decision): the link lands in the
 *   conversation transcript, which is why it is bound to the email, single use
 *   and short-lived.
 * - **redeem** — `/api/invite/redeem` (no session needed to create an account).
 *   The INVITER's floor is re-derived LIVE at redemption, inside the project's
 *   write chain: a demoted or removed inviter's link is dead. The membership
 *   binds only to an account whose email EQUALS the link's — a link forwarded
 *   to someone who happens to be signed in never adds them.
 *
 * The link's origin is the ONE trusted app origin (`resolveTrustedAppOrigin()`,
 * the value `hostPorts.appOrigin` publishes) — no request, so never a `Host`
 * header. The token is 32 random bytes; only its SHA-256 is stored.
 */

import { randomBytes } from 'node:crypto';
import type { InviteLinkProvenance, InviteLinkView } from '@neuralis/package-system/contracts';
import { getProjectById, updateProject } from '../store/ProjectStore';
import type { ProjectRecord } from '../store/projectTypes';
import { createUser, deleteUser, findUserByEmail, getUserById } from '../store/UserStore';
import { resolveActiveUser } from '../auth/memberSession';
import { hashPassword, validatePasswordComplexity } from '../auth/passwordPolicy';
import { writeAuditLog } from '../store/AuditStore';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { resolveTrustedAppOrigin } from '../oauth/appOrigin';
import {
  claimInvite,
  deleteInvite,
  getInviteByToken,
  inviteTokenHash,
  listInvites,
  putInvite,
  releaseInviteClaim,
  type InviteRecord,
} from '../store/InviteStore';
import { checkInviteFloor, memberRecordFor } from './inviteUserToProject';

/** A code floor bounding one project's pending links (and the list scan). */
export const MAX_PENDING_INVITES_PER_PROJECT = 200;
const TOKEN_BYTES = 32;
/** base64url of 32 bytes. Anything else is not a token this host minted. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_EMAIL_CHARS = 254;
const MAX_NAME_CHARS = 200;
const DEFAULT_TTL_HOURS = 168;

type Fail = { ok: false; error: { code: string } };
const fail = (code: string): Fail => ({ ok: false, error: { code } });

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_CHARS || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return email;
}

function ttlMs(): number {
  let hours = DEFAULT_TTL_HOURS;
  try {
    hours = Number(getPlatformConfigStore().get('inviteLinkTtlHours')) || DEFAULT_TTL_HOURS;
  } catch {
    hours = DEFAULT_TTL_HOURS;
  }
  return hours * 60 * 60 * 1000;
}

function viewOf(record: InviteRecord): InviteLinkView {
  return {
    id: record.inviteId,
    email: record.email,
    role: record.role,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    invitedBy: record.inviterUserId,
  };
}

async function liveProject(projectId: string): Promise<ProjectRecord | null> {
  const project = await getProjectById(projectId);
  return project && !project.archivedAt ? project : null;
}

async function auditCaller(
  callerUserId: string,
  action: 'user.invite.issue' | 'user.invite.revoke',
  record: InviteRecord,
  via: InviteLinkProvenance,
): Promise<void> {
  const caller = await getUserById(callerUserId);
  void writeAuditLog({
    userId: callerUserId,
    ...(caller ? { userEmail: caller.email } : {}),
    action,
    target: record.inviteId,
    details: {
      projectId: record.projectId,
      email: record.email,
      role: record.role,
      interactive: via.interactive,
      ...(!via.interactive && via.agentId ? { agentId: via.agentId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// The governance verbs
// ---------------------------------------------------------------------------

export async function issueInviteLink(
  callerUserId: string,
  projectId: string,
  input: { email: string; role?: string },
  via: InviteLinkProvenance,
): Promise<{ ok: true; invite: InviteLinkView; url: string } | Fail> {
  const project = await liveProject(projectId);
  if (!project) return fail('project_not_found');
  const email = normalizeEmail(input.email);
  if (!email) return fail('invalid_email');
  const role = input.role?.trim() || 'member';
  const floor = checkInviteFloor(project, callerUserId, role);
  if (floor) return fail(floor.code);

  const existing = await findUserByEmail(email);
  if (existing && project.members[existing.id]) return fail('already_member');
  const pending = await listInvites(projectId);
  if (pending.length >= MAX_PENDING_INVITES_PER_PROJECT) return fail('too_many_pending');

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const now = Date.now();
  const record: InviteRecord = {
    id: inviteTokenHash(token),
    inviteId: randomBytes(9).toString('base64url'),
    projectId,
    role,
    email,
    inviterUserId: callerUserId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs()).toISOString(),
  };
  await putInvite(record);
  await auditCaller(callerUserId, 'user.invite.issue', record, via);
  return { ok: true, invite: viewOf(record), url: `${resolveTrustedAppOrigin()}/invite#t=${token}` };
}

export async function listInviteLinks(
  callerUserId: string,
  projectId: string,
): Promise<{ ok: true; invites: InviteLinkView[] } | Fail> {
  const project = await liveProject(projectId);
  if (!project) return fail('project_not_found');
  const floor = checkInviteFloor(project, callerUserId, null);
  if (floor) return fail(floor.code);
  return { ok: true, invites: (await listInvites(projectId)).map(viewOf) };
}

/**
 * Revoke one pending link of THIS project. The caller must be able to issue
 * that link's role; an unknown id and a link the caller may not touch are the
 * same `not_found`. A revoke is never human-only — closing a leaked link is
 * exactly what an agent must be able to do.
 */
export async function revokeInviteLink(
  callerUserId: string,
  projectId: string,
  inviteId: string,
  via: InviteLinkProvenance,
): Promise<{ ok: true } | Fail> {
  const project = await liveProject(projectId);
  if (!project) return fail('project_not_found');
  const floor = checkInviteFloor(project, callerUserId, null);
  if (floor) return fail(floor.code);
  const record = (await listInvites(projectId)).find((r) => r.inviteId === inviteId);
  if (!record || checkInviteFloor(project, callerUserId, record.role)) return fail('not_found');
  if (!(await deleteInvite(record))) return fail('not_found');
  await auditCaller(callerUserId, 'user.invite.revoke', record, via);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

/**
 * The ONE refusal for a link that cannot be used — unknown, expired, revoked,
 * already used, its project archived or gone, or its inviter no longer able to
 * invite into its role. The route answers every one with the same bytes.
 */
export const INVITE_INVALID = 'invite_invalid';

export type RedeemFailure =
  | typeof INVITE_INVALID
  | 'account_exists'
  | 'sign_in_required'
  | 'wrong_account'
  | 'invalid_name'
  | 'password_policy';

export type InviteInspection = {
  projectName: string;
  role: string;
  email: string;
  expiresAt: string;
  /** Does an account with the invited email exist? It decides create vs join. */
  account: 'new' | 'existing';
  /** The caller's own session against the link: the invited account, another one, or none. */
  session: 'invitee' | 'other' | 'none';
  /** The ONE trusted app origin — the `host` of the page's "Open in Neuralis Desktop" link. */
  appOrigin: string;
};

type Live = { record: InviteRecord; project: ProjectRecord };

/** A presented token that is usable RIGHT NOW, with the inviter's floor read live. */
async function liveInvite(token: unknown): Promise<Live | null> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const record = await getInviteByToken(token);
  if (!record || record.claimedAt || Date.parse(record.expiresAt) <= Date.now()) return null;
  const project = await liveProject(record.projectId);
  if (!project || checkInviteFloor(project, record.inviterUserId, record.role)) return null;
  return { record, project };
}

async function sessionEmail(sessionUserId: string | null): Promise<{ id: string; email: string } | null> {
  if (!sessionUserId) return null;
  const user = await resolveActiveUser(sessionUserId);
  return user ? { id: user.id, email: user.email.trim().toLowerCase() } : null;
}

export async function inspectInvite(
  token: unknown,
  sessionUserId: string | null,
): Promise<{ ok: true; invite: InviteInspection } | { ok: false; code: RedeemFailure }> {
  const live = await liveInvite(token);
  if (!live) return { ok: false, code: INVITE_INVALID };
  const { record, project } = live;
  const account = (await findUserByEmail(record.email)) ? 'existing' : 'new';
  const me = await sessionEmail(sessionUserId);
  return {
    ok: true,
    invite: {
      projectName: project.name,
      role: record.role,
      email: record.email,
      expiresAt: record.expiresAt,
      account,
      session: !me ? 'none' : me.email === record.email ? 'invitee' : 'other',
      appOrigin: resolveTrustedAppOrigin(),
    },
  };
}

/**
 * Add `user` to the link's project with the link's role, re-deriving the
 * INVITER's floor inside the project's write chain. `refused` = the inviter (or
 * the project) can no longer back this link — the link is dead.
 */
async function joinProject(
  record: InviteRecord,
  user: { id: string; name: string; email: string },
): Promise<'joined' | 'already_member' | 'refused'> {
  // A holder, not a `let`: TypeScript does not track an assignment made inside the producer.
  const seen: { outcome: 'joined' | 'already_member' | 'refused' } = { outcome: 'refused' };
  const written = await updateProject(record.projectId, (p) => {
    if (p.archivedAt || checkInviteFloor(p, record.inviterUserId, record.role)) {
      seen.outcome = 'refused';
      return null;
    }
    if (p.members[user.id]) {
      // An invite never re-roles a member: that is the members patch's floor.
      seen.outcome = 'already_member';
      return null;
    }
    seen.outcome = 'joined';
    return { members: { ...p.members, [user.id]: memberRecordFor(p, user, record.role) } };
  });
  // `null` = the project record is gone.
  return written === null ? 'refused' : seen.outcome;
}

function auditRedeem(user: { id: string; email: string }, record: InviteRecord, account: 'new' | 'existing', joined: boolean): void {
  void writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    action: 'user.invite.redeem',
    target: record.inviteId,
    details: { projectId: record.projectId, role: record.role, inviterUserId: record.inviterUserId, account, joined },
  });
}

/** A NEW account with the invitee's own password, then the membership. */
export async function redeemInviteNewAccount(
  token: unknown,
  input: { name: unknown; password: unknown },
): Promise<{ ok: true; email: string } | { ok: false; code: RedeemFailure; reason?: string }> {
  const live = await liveInvite(token);
  if (!live) return { ok: false, code: INVITE_INVALID };
  const { record } = live;
  if (await findUserByEmail(record.email)) return { ok: false, code: 'account_exists' };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_NAME_CHARS) return { ok: false, code: 'invalid_name' };
  const password = typeof input.password === 'string' ? input.password : '';
  const policy = validatePasswordComplexity(password);
  if (!policy.valid) return { ok: false, code: 'password_policy', reason: policy.reason };

  const claimed = await claimInvite(token as string);
  if (!claimed) return { ok: false, code: INVITE_INVALID };

  let user;
  try {
    user = await createUser(claimed.email, name, await hashPassword(password), {
      status: 'active',
      mustChangePassword: false,
      invitedBy: claimed.inviterUserId,
    });
  } catch (err) {
    await releaseInviteClaim(claimed);
    if (err instanceof Error && err.message.includes('already exists')) return { ok: false, code: 'account_exists' };
    throw err;
  }

  const joined = await joinProject(claimed, user).catch(async (err: unknown) => {
    await deleteUser(user.id);
    await releaseInviteClaim(claimed);
    throw err;
  });
  if (joined === 'refused') {
    // The account was made for THIS membership: never leave one nobody administers.
    await deleteUser(user.id);
    await deleteInvite(claimed);
    return { ok: false, code: INVITE_INVALID };
  }
  await deleteInvite(claimed);
  auditRedeem(user, claimed, 'new', true);
  return { ok: true, email: user.email };
}

/** An EXISTING account joins — only the signed-in account whose email IS the link's. */
export async function redeemInviteExistingAccount(
  token: unknown,
  sessionUserId: string | null,
): Promise<{ ok: true; projectId: string; alreadyMember: boolean } | { ok: false; code: RedeemFailure }> {
  const live = await liveInvite(token);
  if (!live) return { ok: false, code: INVITE_INVALID };
  const me = await sessionEmail(sessionUserId);
  if (!me) return { ok: false, code: 'sign_in_required' };
  if (me.email !== live.record.email) return { ok: false, code: 'wrong_account' };
  const user = await getUserById(me.id);
  if (!user) return { ok: false, code: 'sign_in_required' };

  const claimed = await claimInvite(token as string);
  if (!claimed) return { ok: false, code: INVITE_INVALID };
  const joined = await joinProject(claimed, user).catch(async (err: unknown) => {
    await releaseInviteClaim(claimed);
    throw err;
  });
  await deleteInvite(claimed);
  if (joined === 'refused') return { ok: false, code: INVITE_INVALID };
  auditRedeem(user, claimed, 'existing', joined === 'joined');
  return { ok: true, projectId: claimed.projectId, alreadyMember: joined === 'already_member' };
}

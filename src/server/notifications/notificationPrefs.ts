/**
 * Personal notification settings, per user per project:
 * `<projectsRoot>/<projectId>/notifications/<userId>/prefs.json` =
 * `{ mute: string[], follow: string[] }` — wire event types.
 *
 * - `mute` silences a type even where it would notify by default.
 * - `follow` asks for a type the user is not addressed by (a teammate's
 *   workflow failing). Following never WIDENS what a user may see: the
 *   materializer still runs every gate (member, features, the package's own
 *   visibility predicate) for a follower, and the preferences route only
 *   accepts types from the caller's visible catalog.
 *
 * The FOLLOWER INDEX (type → user ids) is built once per project from every
 * member's `prefs.json` on the first event after boot (O(users) reads, once)
 * and dropped for that project on every write and on a user's removal — it
 * lives in the store's `globalThis` slot, since the routes write in one module
 * graph and the materializer reads in another.
 */

import { readFile } from 'node:fs/promises';
import { durableReplaceFile } from '@neuralis/package-system/data';
import { listContained } from '@neuralis/package-system/paths';
import {
  followerIndexCache,
  inUserChain,
  invalidateFollowerIndex,
  notificationsRoot,
  userFile,
} from './notificationStore';

export type NotificationPrefs = { mute: string[]; follow: string[] };

/** A cap on each list — a settings file, never a growing log. */
export const MAX_PREF_TYPES = 256;

function sanitize(raw: unknown): NotificationPrefs {
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 160))].slice(0, MAX_PREF_TYPES)
      : [];
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { mute: list(obj.mute), follow: list(obj.follow) };
}

export async function readNotificationPrefs(projectId: string, userId: string): Promise<NotificationPrefs> {
  const path = userFile(projectId, userId, 'prefs.json');
  if (!path) return { mute: [], follow: [] };
  try {
    return sanitize(JSON.parse(await readFile(path.realPath, 'utf-8')));
  } catch {
    return { mute: [], follow: [] };
  }
}

/** Replace the user's settings in this project (in the user's chain) and drop the project's follower index. */
export async function writeNotificationPrefs(
  projectId: string,
  userId: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const path = userFile(projectId, userId, 'prefs.json');
  if (!path) throw new Error('Invalid notification settings owner');
  const clean = sanitize(prefs);
  await inUserChain(projectId, userId, () =>
    durableReplaceFile(path.realPath, JSON.stringify(clean), { mode: 0o600 }),
  );
  invalidateFollowerIndex(projectId);
  return clean;
}

/** The users of `projectId` who follow `type` — from the per-project index, built on first use. */
export async function followersOf(projectId: string, type: string): Promise<string[]> {
  const cache = followerIndexCache();
  let index = cache.get(projectId);
  if (!index) {
    index = await buildFollowerIndex(projectId);
    cache.set(projectId, index);
  }
  return [...(index.get(type) ?? [])];
}

async function buildFollowerIndex(projectId: string): Promise<Map<string, Set<string>>> {
  const index = new Map<string, Set<string>>();
  const root = notificationsRoot(projectId);
  if (!root) return index;
  const listed = await listContained(root);
  if (!listed.ok) return index;
  for (const entry of listed.entries) {
    if (!entry.isDirectory) continue;
    const prefs = await readNotificationPrefs(projectId, entry.name);
    for (const type of prefs.follow) {
      let followers = index.get(type);
      if (!followers) {
        followers = new Set();
        index.set(type, followers);
      }
      followers.add(entry.name);
    }
  }
  return index;
}

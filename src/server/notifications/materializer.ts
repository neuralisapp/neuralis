/**
 * The notification MATERIALIZER — turns a published package event into rows
 * in the recipients' notification stores (`notificationStore.ts`).
 *
 * It subscribes to the runtime provider's event surface
 * (`RuntimeInstance.events()`) once, right after the host bootstrap reaches
 * `ready`. Per event:
 *
 *   recipients = event.audience.userIds ∪ followers(type)          (prefs index)
 *   per recipient, every gate a reader of the event's route would meet:
 *     not a sentinel → an ACTIVE MEMBER of the project (the ONE host member
 *     chain, `resolveMember`) → the package is visible to them (project scope +
 *     base-access feature) → `meetsRequires(declaration.requires)` → the owning
 *     package's own `visible(event, session)` predicate
 *   then the user's settings: muted ⇒ nothing; addressed + default `on` or
 *   followed ⇒ a row (merged into its unread twin), and the live counts signal.
 *
 * ORDER: events about one subject (`projectId`, publishing package,
 * `subjectId`) are materialized one after another, in publish order — a
 * failure, its recovery and the next failure land in that order whatever the
 * per-recipient awaits take. Other subjects never wait.
 *
 * RESOLUTION (`notify.clears`): an event that clears other types also reaches
 * every member holding an UNREAD row of those types about the same subject
 * (found from the project's user directories, one `state.json` read each);
 * for every candidate the event is VISIBLE to, those rows are marked read —
 * before, and regardless of, the mute/follow decision about the event's own
 * row. An undecided verdict clears nothing.
 *
 * The row carries the declaration's tone and dock, and a title composed from
 * the declaration's title and — when the event data declares one — a string
 * `data.title` (the workflow's name). A `data.nav` of shape
 * `{ widgetType: string, initialState?: object }` becomes the row's `nav`.
 * Nothing else from `data` is stored.
 *
 * Delivery is in-process, at most once, and not replayed: an event published
 * while the process restarts is not delivered (named residual).
 */

import type {
  NeuralisEvent,
  PackageEventDeclaration,
  RuntimeInstance,
  SessionContext,
} from '@neuralis/package-system/contracts';
import { isSentinelId } from '@neuralis/package-system/contracts';
import { meetsRequires } from '@neuralis/package-system/access';
import { resolveMember } from '../auth/memberSession';
import { getCommunityPackageRegistry } from '../packages/runtime';
import { isPackageDefinitionVisible } from '../packages/packageVisibility';
import type { ProjectRecord } from '../store/projectTypes';
import { getLogger } from '../logging/setup';
import { eventWireType } from '@neuralis/package-system/contracts';
import { listContained } from '@neuralis/package-system/paths';
import {
  MAX_NOTIFICATION_TITLE_CHARS,
  deliverNotification,
  hasUnreadOf,
  notificationsRoot,
  resolveUnread,
  type NotificationNav,
} from './notificationStore';
import { followersOf, readNotificationPrefs } from './notificationPrefs';

type EventsSurface = ReturnType<RuntimeInstance['events']>;

type MaterializerSlot = {
  stop?: () => void;
  delivered: number;
  skipped: number;
  /** Unread rows marked read by a resolving event. */
  resolved: number;
  /** One chain per subject — `(projectId, packageId, subjectId)` → the tail of its queue. */
  subjects: Map<string, Promise<unknown>>;
};

const SLOT = Symbol.for('@neuralis/host:notificationMaterializer');

function slot(): MaterializerSlot {
  const g = globalThis as { [SLOT]?: MaterializerSlot };
  return (g[SLOT] ??= { delivered: 0, skipped: 0, resolved: 0, subjects: new Map() });
}

/**
 * May this member read events of this package at all? The same ladder the
 * workspace snapshot applies (project install scope + base-access feature) —
 * a package hidden from them never notifies them, and its rows are dropped on
 * read. `'missing'`: the package is not loaded, so nothing can be said.
 */
function eventPackageVisibility(
  packageId: string,
  session: SessionContext,
  project: Pick<ProjectRecord, 'packageAccessFeature'>,
): 'visible' | 'denied' | 'missing' {
  const definition = getCommunityPackageRegistry().getPackage(packageId);
  if (!definition) return 'missing';
  const grantedFeatures = [...(session.grantedFeatures ?? [])];
  const visible = isPackageDefinitionVisible(
    definition,
    {
      host: 'neuralis-workspace',
      projectId: session.projectId,
      userId: session.userId,
      role: session.role,
      grantedFeatures,
      packageAccessFeature: project.packageAccessFeature,
    },
    grantedFeatures,
  );
  return visible ? 'visible' : 'denied';
}

/** {@link eventPackageVisibility} as a yes/no — a package that is not loaded is a no. */
export function isEventPackageVisible(
  packageId: string,
  session: SessionContext,
  project: Pick<ProjectRecord, 'packageAccessFeature'>,
): boolean {
  return eventPackageVisibility(packageId, session, project) === 'visible';
}

export type EventReadVerdict = 'visible' | 'denied' | 'indeterminate';

/**
 * One reader's verdict on one event. `'denied'` is DEFINITIVE and comes only
 * from the session: the package is loaded and hidden from them, or they lack
 * the declaration's features. Everything that cannot be judged right now — the
 * package not loaded, the owning package's predicate saying no or throwing
 * (its own state may still be loading) — is `'indeterminate'`.
 *
 * Shared by the materializer (write time: only `'visible'` delivers) and the
 * list route (read time — a row outlives a revocation, so it is re-judged on
 * every read: both non-visible verdicts hide the row, and only `'denied'` may
 * drop its unread entry). Never promote an `'indeterminate'` into a write.
 */
export async function mayReadEvent(
  events: EventsSurface,
  event: NeuralisEvent,
  declaration: PackageEventDeclaration,
  packageId: string,
  session: SessionContext,
  project: Pick<ProjectRecord, 'packageAccessFeature'>,
): Promise<EventReadVerdict> {
  const packageVerdict = eventPackageVisibility(packageId, session, project);
  if (packageVerdict === 'missing') return 'indeterminate';
  if (packageVerdict === 'denied') return 'denied';
  if (!meetsRequires(session, declaration.requires)) return 'denied';
  try {
    return (await events.isVisible(event, session)) ? 'visible' : 'indeterminate';
  } catch {
    return 'indeterminate';
  }
}

/** The row title: `"<data.title> — <declaration title>"`, or the declaration title alone. */
export function notificationTitle(declaration: PackageEventDeclaration, data: Record<string, unknown>): string {
  const subject = typeof data.title === 'string' ? data.title.trim() : '';
  const title = subject ? `${subject} — ${declaration.title}` : declaration.title;
  return title.slice(0, MAX_NOTIFICATION_TITLE_CHARS);
}

/** A `data.nav` the host can carry without interpreting it, or `undefined`. */
export function notificationNav(data: Record<string, unknown>): NotificationNav | undefined {
  const nav = data.nav;
  if (!nav || typeof nav !== 'object' || Array.isArray(nav)) return undefined;
  const { widgetType, initialState } = nav as Record<string, unknown>;
  if (typeof widgetType !== 'string' || widgetType.length === 0 || widgetType.length > 128) return undefined;
  if (initialState !== undefined && (!initialState || typeof initialState !== 'object' || Array.isArray(initialState))) {
    return undefined;
  }
  return { widgetType, ...(initialState ? { initialState: initialState as Record<string, unknown> } : {}) };
}

/** Run `fn` behind every earlier event about the same subject; the chain entry goes when empty. */
function inSubjectOrder<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const subjects = slot().subjects;
  const prev = subjects.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  subjects.set(key, next);
  const release = () => { if (subjects.get(key) === next) subjects.delete(key); };
  next.then(release, release);
  return next;
}

/**
 * The members holding an unread row of `types` about `subjectId` — the former
 * recipients a resolution concerns. One directory listing and one `state.json`
 * read per user, sequentially (O(users in the project)); run only for an event
 * that clears something.
 */
async function holdersOfUnread(projectId: string, types: readonly string[], subjectId: string): Promise<string[]> {
  const root = notificationsRoot(projectId);
  if (!root) return [];
  const listed = await listContained(root);
  if (!listed.ok) return [];
  const holders: string[] = [];
  for (const entry of listed.entries) {
    if (entry.isDirectory && await hasUnreadOf(projectId, entry.name, types, subjectId)) holders.push(entry.name);
  }
  return holders;
}

/**
 * Materialize one event for every recipient that passes every gate, in order
 * with the other events about its subject. Returns the delivered count.
 */
export function materializeEvent(events: EventsSurface, event: NeuralisEvent): Promise<number> {
  const resolved = events.declarationOf(event.type);
  const packageId = resolved?.packageId ?? event.source;
  return inSubjectOrder(`${event.projectId}\u0000${packageId}\u0000${event.subjectId}`, () => materializeNow(events, event));
}

async function materializeNow(events: EventsSurface, event: NeuralisEvent): Promise<number> {
  const resolved = events.declarationOf(event.type);
  if (!resolved) return 0;
  const { declaration, packageId } = resolved;
  const addressed = new Set(event.audience?.userIds ?? []);
  const clears = (declaration.notify?.clears ?? []).map((id) => eventWireType(packageId, id));
  const holders = clears.length > 0 ? await holdersOfUnread(event.projectId, clears, event.subjectId) : [];
  const recipients = new Set([...addressed, ...(await followersOf(event.projectId, event.type)), ...holders]);
  const defaultOn = declaration.notify?.default === 'on';
  let delivered = 0;
  let resolvedRows = 0;

  for (const userId of recipients) {
    try {
      if (isSentinelId(userId)) continue;
      const member = await resolveMember(userId, event.projectId);
      if (!member) continue;
      if ((await mayReadEvent(events, event, declaration, packageId, member.session, member.project)) !== 'visible') continue;
      // A definitive VISIBLE verdict for this reader: the failure this event
      // resolves is resolved for them, whatever they chose about this type.
      if (clears.length > 0) resolvedRows += await resolveUnread(event.projectId, userId, clears, event.subjectId);
      const prefs = await readNotificationPrefs(event.projectId, userId);
      if (prefs.mute.includes(event.type)) continue;
      const wanted = (addressed.has(userId) && defaultOn) || prefs.follow.includes(event.type);
      if (!wanted) continue;
      const nav = notificationNav(event.data);
      const written = await deliverNotification(event.projectId, userId, {
        type: event.type,
        packageId,
        ...(declaration.dock ? { dock: declaration.dock } : {}),
        subjectId: event.subjectId,
        tone: declaration.notify?.tone ?? 'info',
        title: notificationTitle(declaration, event.data),
        ...(nav ? { nav } : {}),
      });
      if (written) delivered += 1;
    } catch (err) {
      getLogger().child('notifications').warn('notification delivery failed', {
        type: event.type,
        projectId: event.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const counters = slot();
  counters.delivered += delivered;
  counters.skipped += recipients.size - delivered;
  counters.resolved += resolvedRows;
  return delivered;
}

/**
 * Subscribe the materializer to the runtime's events — idempotent (one
 * subscription per process). A runtime without an event surface is logged and
 * left alone; notifications stay off rather than failing the boot.
 */
export function startNotificationMaterializer(runtime: RuntimeInstance): void {
  const s = slot();
  if (s.stop) return;
  let events: EventsSurface;
  try {
    events = runtime.events();
  } catch (err) {
    getLogger().child('notifications').warn('runtime has no event surface — notifications are off', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const unsubscribe = events.subscribe((event) => {
    void materializeEvent(events, event).catch((err: unknown) => {
      getLogger().child('notifications').warn('notification materialization failed', {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  s.stop = () => {
    unsubscribe();
    s.stop = undefined;
  };
}

/** Delivered / skipped recipient counts, resolved rows and subjects in flight — the measurement the live row reads. */
export function notificationMaterializerStats(): {
  delivered: number; skipped: number; resolved: number; subjectsInFlight: number; running: boolean;
} {
  const s = slot();
  return { delivered: s.delivered, skipped: s.skipped, resolved: s.resolved, subjectsInFlight: s.subjects.size, running: Boolean(s.stop) };
}

/** Test-only: unsubscribe and reset the counters. */
export function resetNotificationMaterializerForTests(): void {
  const s = slot();
  s.stop?.();
  s.delivered = 0;
  s.skipped = 0;
  s.resolved = 0;
  s.subjects.clear();
}

/**
 * The user's dock arrangement — ORDER and HIDDEN — applied to the live dock
 * items, plus the edit-mode draft operations. Pure: no store, no DOM.
 *
 * An item takes part only when it carries a `prefKey` (`<packageId>:<dockId>`
 * for a package dock item — the same key the notification badge reads — or
 * `agent:<id>` for an agent tile). Items without one (the account and project
 * headers, the Layout item, "Create agent", separators) are FIXED: never
 * moved, never hidden.
 *
 * Reordering stays INSIDE a `group` (a trust tier on the primary dock, own vs
 * other agents on the secondary): a group's members trade the group's own
 * position slots, so a separator between two groups never moves and an item
 * can never cross it. A stored key that names no live item never renders; a
 * live item the stored order does not name goes to the end of its group.
 */

import type { DockPrefs } from '../store/types';

/** Bound on stored keys per list — a dock never has this many items. */
export const DOCK_PREFS_MAX_KEYS = 200;
const MAX_KEY_CHARS = 300;

/** The key of a package dock item: the manifest package id + the dock surface id. */
export function packageDockKey(packageId: string, dockId: string): string {
  return `${packageId}:${dockId}`;
}

/** The key of an agent tile on the secondary dock. */
export function agentDockKey(agentId: string): string {
  return `agent:${agentId}`;
}

export type ArrangeableItem = {
  id: string;
  position: number;
  prefKey?: string;
  group?: string;
  hidden?: boolean;
};

function keyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_KEY_CHARS || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= DOCK_PREFS_MAX_KEYS) break;
  }
  return out;
}

/** A stored (or about-to-be-stored) arrangement, bounded and de-duplicated; anything malformed reads as empty. */
export function normalizeDockPrefs(raw: unknown): DockPrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { order: keyList(obj.order), hidden: keyList(obj.hidden) };
}

/**
 * The live items in the user's arrangement: within each group the members are
 * ranked by the stored order (unknown keys after, in their default order) and
 * take the group's own position slots; `hidden` is set from the stored set.
 * Returned sorted by position.
 */
export function applyDockPrefs<T extends ArrangeableItem>(items: readonly T[], prefs: DockPrefs | undefined): T[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  if (!prefs) return sorted;
  const { order, hidden } = normalizeDockPrefs(prefs);
  const rank = new Map<string, number>();
  order.forEach((key, index) => rank.set(key, index));
  const hiddenSet = new Set(hidden);

  const groups = new Map<string, T[]>();
  for (const item of sorted) {
    if (!item.prefKey || !item.group) continue;
    const members = groups.get(item.group) ?? [];
    members.push(item);
    groups.set(item.group, members);
  }

  const placed = new Map<T, T>();
  for (const members of groups.values()) {
    const slots = members.map((m) => m.position);
    const ranked = members
      .map((m, index) => ({ m, index, r: rank.get(m.prefKey as string) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => (a.r === b.r ? a.index - b.index : a.r - b.r));
    ranked.forEach(({ m }, i) => {
      placed.set(m, { ...m, position: slots[i] as number, hidden: hiddenSet.has(m.prefKey as string) });
    });
  }

  return sorted
    .map((item) => placed.get(item) ?? item)
    .sort((a, b) => a.position - b.position);
}

/** The edit-mode draft that reproduces what the dock shows now. */
export function draftFromItems(items: readonly ArrangeableItem[]): DockPrefs {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const order: string[] = [];
  const hidden: string[] = [];
  for (const item of sorted) {
    if (!item.prefKey) continue;
    order.push(item.prefKey);
    if (item.hidden) hidden.push(item.prefKey);
  }
  return { order, hidden };
}

/**
 * The draft with every live keyed item in it — an item that appeared while
 * the editor was open (a package installed, an agent created) joins at the
 * end of the order, so it can be moved like the rest. Same object when none is missing.
 */
export function extendDraft(draft: DockPrefs, items: readonly ArrangeableItem[]): DockPrefs {
  const known = new Set(draft.order);
  const missing = [...items]
    .sort((a, b) => a.position - b.position)
    .flatMap((item) => (item.prefKey && !known.has(item.prefKey) ? [item.prefKey] : []));
  return missing.length === 0 ? draft : { ...draft, order: [...draft.order, ...missing] };
}

function groupOf(items: readonly ArrangeableItem[], key: string): string | undefined {
  return items.find((item) => item.prefKey === key)?.group;
}

/**
 * Move `key` next to `targetKey` — only inside one group. Returns the SAME
 * draft object when nothing changes (a cross-group or self drop, an unknown
 * key), so a drag-over that lands where the item already is re-renders nothing.
 */
export function moveDockKey(
  draft: DockPrefs,
  items: readonly ArrangeableItem[],
  key: string,
  targetKey: string,
  place: 'before' | 'after',
): DockPrefs {
  if (key === targetKey) return draft;
  const group = groupOf(items, key);
  if (!group || group !== groupOf(items, targetKey)) return draft;
  if (!draft.order.includes(key) || !draft.order.includes(targetKey)) return draft;
  const without = draft.order.filter((k) => k !== key);
  const at = without.indexOf(targetKey) + (place === 'after' ? 1 : 0);
  const next = [...without.slice(0, at), key, ...without.slice(at)];
  if (next.every((k, i) => k === draft.order[i])) return draft;
  return { ...draft, order: next };
}

/** Move `key` one VISIBLE place earlier (`-1`) or later (`1`) in its group — the keyboard path. */
export function stepDockKey(
  draft: DockPrefs,
  items: readonly ArrangeableItem[],
  key: string,
  delta: -1 | 1,
): DockPrefs {
  const group = groupOf(items, key);
  if (!group) return draft;
  const siblings = applyDockPrefs(items, draft).filter((item) => item.group === group && !item.hidden);
  const index = siblings.findIndex((item) => item.prefKey === key);
  const neighbour = index === -1 ? undefined : siblings[index + delta];
  if (!neighbour?.prefKey) return draft;
  return moveDockKey(draft, items, key, neighbour.prefKey, delta < 0 ? 'before' : 'after');
}

/** Hide or show `key` in the draft (its place in the order is kept). */
export function setDockKeyHidden(draft: DockPrefs, key: string, hide: boolean): DockPrefs {
  const has = draft.hidden.includes(key);
  if (hide === has || !draft.order.includes(key)) return draft;
  return { ...draft, hidden: hide ? [...draft.hidden, key] : draft.hidden.filter((k) => k !== key) };
}

/**
 * Where a drop lands relative to the item under the pointer — along the dock's
 * OWN axis: the vertical position on a side dock, the horizontal one on a top or
 * bottom dock.
 */
export function dropPlacement(
  rect: { top: number; left: number; width: number; height: number },
  pointer: { x: number; y: number },
  horizontal: boolean,
): 'before' | 'after' {
  return horizontal
    ? (pointer.x < rect.left + rect.width / 2 ? 'before' : 'after')
    : (pointer.y < rect.top + rect.height / 2 ? 'before' : 'after');
}

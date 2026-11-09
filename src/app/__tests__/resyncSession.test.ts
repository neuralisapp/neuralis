/**
 * `resyncSession` speaks next-auth's own cross-tab session channel to the page
 * itself — the ONE in-tab way to make the mounted `SessionProvider` read
 * `/api/auth/session` again after a failed read left it `null`.
 *
 * Pinned against the library's REAL receiver (`BroadcastChannel().receive`, the
 * handler `SessionProvider` registers and answers with
 * `_getSession({ event: 'storage' })` → a fresh `getSession`): if next-auth
 * renames its key or message shape, this row turns red before the workspace
 * silently stops recovering the signed-in user.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The library's own channel, as `next-auth/react` imports it.
import { BroadcastChannel } from 'next-auth/client/_utils';
import { resyncSession } from '../providers';

const g = globalThis as Record<string, unknown>;

beforeEach(() => { g.window = new EventTarget(); });
afterEach(() => { delete g.window; });

describe('resyncSession', () => {
  it('reaches the receiver next-auth\'s SessionProvider listens with, as a session message', () => {
    const received: unknown[] = [];
    const stop = BroadcastChannel().receive((message: unknown) => { received.push(message); });
    resyncSession();
    stop();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(expect.objectContaining({ event: 'session', data: { trigger: 'getSession' } }));
  });

  it('is a no-op on the server (no window)', () => {
    delete g.window;
    expect(() => resyncSession()).not.toThrow();
  });
});

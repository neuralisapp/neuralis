'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

/** The `localStorage` key next-auth's cross-tab session channel listens on. */
const SESSION_CHANNEL_KEY = 'nextauth.message';

/**
 * Ask the mounted `SessionProvider` to read `/api/auth/session` again.
 *
 * next-auth v4 answers a session fetch that failed (the host restarting) with
 * `null` — signed out — and from then on ignores its own focus refetch while
 * the session is `null`; `update()` refuses without a session. Its one in-tab
 * re-read is the cross-tab channel's `storage` event, which this sends to the
 * page itself (other tabs never see a dispatched event). The workspace calls
 * it on a hub connect while the session reads signed out: the page was served
 * to a signed-in user, so that `null` is a failed read until the host says
 * otherwise. One `GET /api/auth/session` per call.
 */
export function resyncSession(): void {
  if (typeof window === 'undefined') return;
  const message = { event: 'session', data: { trigger: 'getSession' }, timestamp: Math.floor(Date.now() / 1000) };
  window.dispatchEvent(Object.assign(new Event('storage'), { key: SESSION_CHANNEL_KEY, newValue: JSON.stringify(message) }));
}

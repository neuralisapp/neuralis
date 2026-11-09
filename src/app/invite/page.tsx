'use client';

import { signIn, signOut } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import FibonacciBackdrop from '../auth/FibonacciBackdrop';
import { desktopJoinLink, readInviteToken } from './inviteToken';

/**
 * `/invite#t=<token>` — accept an invite link. The token is read from the
 * fragment once, the fragment is dropped from the address bar, and every
 * decision is the server's (`POST /api/invite/redeem`): this page never learns
 * more than the link offers, and it never signs anyone in by itself — a new
 * account signs in with the password its owner just chose, an existing one with
 * its own.
 */

type Inspection = {
  projectName: string;
  role: string;
  email: string;
  expiresAt: string;
  account: 'new' | 'existing';
  session: 'invitee' | 'other' | 'none';
  appOrigin: string;
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; invite: Inspection }
  | { kind: 'joined' };

const ERROR_TEXT: Record<string, string> = {
  invite_invalid: 'This invite link cannot be used. It may have expired, been used or been withdrawn — ask for a new one.',
  account_exists: 'An account with this email already exists. Sign in with it to accept the invite.',
  sign_in_required: 'Sign in with the invited account first.',
  wrong_account: 'You are signed in with a different account than the one this invite is for.',
  invalid_name: 'Enter your name (at most 200 characters).',
  rate_limited: 'Too many attempts from this network. Wait a minute and try again.',
};

async function redeem(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch('/api/invite/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

function errorText(data: Record<string, unknown>): string {
  const code = typeof data.error === 'string' ? data.error : '';
  if (code === 'password_policy' && typeof data.reason === 'string') return data.reason;
  return ERROR_TEXT[code] ?? 'Something went wrong. Try again.';
}

const INPUT =
  'w-full rounded-md border border-emerald-300/70 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/45 focus:border-emerald-200';
const BUTTON =
  'w-full rounded-md bg-emerald-500 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60';

export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inspect = useCallback(async (value: string) => {
    const { status, data } = await redeem({ token: value, action: 'inspect' });
    if (status === 200) setPhase({ kind: 'ready', invite: data as unknown as Inspection });
    else if (status === 404) setPhase({ kind: 'invalid' });
    else {
      setPhase({ kind: 'invalid' });
      setError(errorText(data));
    }
  }, []);

  // Read ONCE: the fragment is gone after the first read, and a re-run effect
  // (React's development double-invoke) must not mistake that for "no token".
  const read = useRef<{ token: string | null } | null>(null);

  useEffect(() => {
    if (!read.current) {
      read.current = { token: readInviteToken(window.location.hash) };
      // Drop the fragment so the token does not linger in the address bar or history.
      window.history.replaceState(null, '', window.location.pathname);
    }
    const value = read.current.token;
    setToken(value);
    if (!value) {
      setPhase({ kind: 'invalid' });
      return;
    }
    void inspect(value);
  }, [inspect]);

  async function join(): Promise<void> {
    if (!token) return;
    const { status, data } = await redeem({ token, action: 'join' });
    if (status === 200) {
      setPhase({ kind: 'joined' });
      router.push('/workspace');
      return;
    }
    if (status === 404) setPhase({ kind: 'invalid' });
    setError(errorText(data));
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token || phase.kind !== 'ready') return;
    if (password !== confirm) {
      setError('The two passwords differ.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { status, data } = await redeem({ token, action: 'create', name: name.trim(), password });
      if (status !== 201) {
        if (status === 404) setPhase({ kind: 'invalid' });
        setError(errorText(data));
        return;
      }
      setPhase({ kind: 'joined' });
      const result = await signIn('credentials', { email: phase.invite.email, password, action: 'login', redirect: false });
      router.push(result?.error ? '/auth' : '/workspace');
    } finally {
      setBusy(false);
    }
  }

  async function handleSignIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token || phase.kind !== 'ready') return;
    setBusy(true);
    setError('');
    try {
      const result = await signIn('credentials', { email: phase.invite.email, password, action: 'login', redirect: false });
      if (result?.error) {
        setError('Incorrect password.');
        return;
      }
      await join();
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitchAccount(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      await signOut({ redirect: false });
      await inspect(token);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden">
      <FibonacciBackdrop />
      <div className="relative z-10 flex w-full max-w-[380px] flex-col items-center gap-3.5 px-6 py-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/30 bg-white/[0.08] text-white">
          <UserPlus size={34} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">You are invited</h1>

        {phase.kind === 'loading' ? <p className="text-sm text-white/60">Checking the invite…</p> : null}
        {phase.kind === 'invalid' ? (
          <p className="text-sm text-white/75">{error || ERROR_TEXT.invite_invalid}</p>
        ) : null}
        {phase.kind === 'joined' ? <p className="text-sm text-white/75">Welcome — opening your workspace…</p> : null}

        {phase.kind === 'ready' ? (
          <>
            <p className="text-sm text-white/75">
              Join <strong className="text-white">{phase.invite.projectName}</strong> as{' '}
              <strong className="text-white">{phase.invite.role}</strong>, with the account{' '}
              <strong className="text-white">{phase.invite.email}</strong>.
            </p>

            {phase.invite.account === 'new' ? (
              // noValidate: the browser's own length check would block the submit
              // silently; the server's policy answer names what is missing.
              <form onSubmit={handleCreate} noValidate className="flex w-full flex-col gap-3">
                <input className={INPUT} type="email" value={phase.invite.email} readOnly aria-label="Email" />
                <input className={INPUT} type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                <input className={INPUT} type="password" placeholder="Choose a password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
                <input className={INPUT} type="password" placeholder="Repeat the password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={12} autoComplete="new-password" />
                <p className="text-[11px] text-white/50">At least 12 characters, with upper- and lowercase letters, a number and a symbol.</p>
                <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Creating…' : 'Create account and join'}</button>
              </form>
            ) : phase.invite.session === 'invitee' ? (
              <button type="button" disabled={busy} onClick={() => void join()} className={BUTTON}>Join the project</button>
            ) : phase.invite.session === 'other' ? (
              <div className="flex w-full flex-col gap-3">
                <p className="text-sm text-amber-200/90">{ERROR_TEXT.wrong_account}</p>
                <button type="button" disabled={busy} onClick={() => void handleSwitchAccount()} className={BUTTON}>Sign out and continue</button>
              </div>
            ) : (
              <form onSubmit={handleSignIn} className="flex w-full flex-col gap-3">
                <input className={INPUT} type="email" value={phase.invite.email} readOnly aria-label="Email" />
                <input className={INPUT} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="current-password" />
                <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Signing in…' : 'Sign in and join'}</button>
              </form>
            )}
            {error ? <p className="text-sm text-red-200">{error}</p> : null}
            {token ? (
              <a
                href={desktopJoinLink(phase.invite.appOrigin, token)}
                className="text-xs text-white/60 underline underline-offset-2 hover:text-white"
              >
                Open in Neuralis Desktop
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

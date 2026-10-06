'use client';

import { signIn } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Terminal } from 'lucide-react';
import FibonacciBackdrop from './FibonacciBackdrop';
import { DEFAULT_CALLBACK_URL, resolveCallbackTarget, type CallbackTarget } from './callbackUrl';

type View = 'login' | 'setup-required';

export default function AuthPage() {
  const router = useRouter();

  const [view, setView] = useState<View | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Validated at the query READ, so component state can only ever hold a
  // target that is safe to navigate to (see ./callbackUrl.ts).
  const [target, setTarget] = useState<CallbackTarget>({ kind: 'relative', url: DEFAULT_CALLBACK_URL });

  useEffect(() => {
    let mounted = true;

    async function checkBootstrap() {
      try {
        const res = await fetch('/api/auth/users', { cache: 'no-store' });
        const json = await res.json();

        if (!mounted) return;

        if (json.bootstrapRequired) {
          setView('setup-required');
        } else {
          setView('login');
        }
      } catch {
        if (!mounted) return;
        setView('setup-required');
      }
    }

    void checkBootstrap();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const raw = new URLSearchParams(window.location.search).get('callbackUrl');
    setTarget(resolveCallbackTarget(raw, window.location.hostname));
  }, []);

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      email: email.trim(),
      password,
      action: 'login',
      callbackUrl: target.url,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('Incorrect email or password.');
      return;
    }

    // Navigate to the target validated against THIS browser's origin, never to
    // `result.url`: with `redirect: false` next-auth returns the server's
    // resolution of the posted callbackUrl against NEXTAUTH_URL, which on any
    // non-localhost deployment is the localhost bounce this fix exists to stop.
    if (target.kind === 'absolute') {
      window.location.assign(target.url);
      return;
    }
    router.push(target.url);
  }

  // Loading state
  if (!view) {
    return (
      <div className="fixed inset-0 flex items-center justify-center overflow-hidden">
        <FibonacciBackdrop />
        <div className="relative z-10">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden">
      <FibonacciBackdrop />

      <div className="relative z-10 flex w-full max-w-[360px] flex-col items-center px-6 py-8">
        {view === 'login' && (
          <form onSubmit={handleLoginSubmit} className="flex w-full flex-col items-center gap-3.5">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/30 bg-white/[0.08] text-white shadow-[0_0_24px_rgba(255,255,255,0.06)]">
              <Lock size={34} />
            </div>

            <div className="text-center">
              <h1 className="text-4xl font-semibold tracking-tight text-white">Neuralis</h1>
              <p className="mt-1.5 text-base text-white/70">Sign in to continue</p>
            </div>

            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="mt-2 w-full rounded-md border border-emerald-300/70 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/45 focus:border-emerald-200"
            />

            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full rounded-md border border-emerald-300/70 bg-black/40 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/45 focus:border-emerald-200"
            />

            {error && <p className="text-sm text-red-200">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-emerald-500 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}

        {view === 'setup-required' && (
          <div className="flex w-full flex-col items-center gap-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/30 bg-white/[0.08] text-white shadow-[0_0_24px_rgba(255,255,255,0.06)]">
              <Terminal size={34} />
            </div>

            <h1 className="text-center text-3xl font-semibold text-white">Setup Required</h1>

            <p className="text-center text-sm leading-relaxed text-white/70">
              Neuralis needs initial setup before you can sign in.
              Run one of these commands in your terminal:
            </p>

            <div className="w-full space-y-2">
              <div className="rounded-md border border-white/20 bg-black/50 px-4 py-3">
                <p className="text-xs font-medium text-white/50 mb-1">npm install</p>
                <code className="text-sm font-mono text-emerald-300">npx neuralis setup</code>
              </div>

              <div className="rounded-md border border-white/20 bg-black/50 px-4 py-3">
                <p className="text-xs font-medium text-white/50 mb-1">git clone</p>
                <code className="text-sm font-mono text-emerald-300">pnpm neuralis:setup</code>
              </div>
            </div>

            <p className="text-center text-xs text-white/40 mt-2">
              After setup completes, refresh this page to sign in.
            </p>

            <button
              onClick={() => window.location.reload()}
              className="mt-1 w-full rounded-md border border-white/30 bg-white/[0.08] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/[0.12]"
            >
              Refresh
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

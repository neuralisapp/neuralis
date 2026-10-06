'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { changeOwnPassword } from '@/api/admin';

type Props = {
  userId: string;
  forced?: boolean;
  onSuccess: () => void;
  onClose?: () => void;
};

export default function PasswordChangeModal({ userId, forced, onSuccess, onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await changeOwnPassword(userId, currentPassword, newPassword);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-white/20 bg-zinc-900 p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2 text-white">
          <Lock size={20} />
          <h2 className="text-lg font-semibold">
            {forced ? 'Password change required' : 'Change password'}
          </h2>
        </div>

        {forced && (
          <p className="mb-4 text-sm text-white/70">
            Your account requires a password change before you can continue.
          </p>
        )}

        <div className="flex flex-col gap-3">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
            className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-emerald-300"
          />
          <input
            type="password"
            placeholder="New password (min. 6 characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={6}
            className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-emerald-300"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={6}
            className="rounded-md border border-white/20 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-emerald-300"
          />
        </div>

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {loading ? 'Saving...' : 'Change password'}
          </button>
          {!forced && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/20 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

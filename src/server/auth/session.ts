import { getServerSession } from 'next-auth';
import { authOptions } from './authOptions';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const user = session.user as Record<string, unknown>;
  if (!user.id || typeof user.id !== 'string') return null;
  return {
    id: user.id,
    email: (user.email as string) || '',
    name: (user.name as string) || '',
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('Unauthorized');
  return user;
}

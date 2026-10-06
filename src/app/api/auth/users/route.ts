import { NextResponse } from 'next/server';
import { isSetupComplete } from '@/server/init';
import { hasAnyUsers } from '@/server/store/UserStore';

/**
 * GET /api/auth/users — the login page's one question: does this instance
 * still need its first account? Unauthenticated, and it answers nothing else —
 * the user directory is not served here to anyone (an administrator's roster is
 * `/api/admin/users`, scoped to the projects they administer).
 */
export async function GET(): Promise<NextResponse> {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    return NextResponse.json({ bootstrapRequired: true });
  }
  return NextResponse.json({ bootstrapRequired: !(await hasAnyUsers()) });
}

/**
 * The NextAuth session cookie's names — secure first (production, https), then
 * the plain one (dev, http). ONE list: the `:3101` cookie decode reads it, and
 * the request proxy's boundary gate asks whether a request carries it (that
 * module graph must not pull the user stores in, so the names live apart).
 */
export const SESSION_COOKIE_NAMES = ['__Secure-next-auth.session-token', 'next-auth.session-token'] as const;

import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { findUserByEmail, isActiveUser, sessionEpochOf, updateUser } from '../store/UserStore';
import { resolveActiveUser } from './memberSession';
import { getLogger } from '../logging/setup';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { SetupRequiredError, assertSetupComplete } from '../init';
import { beginLoginAttempt, recordLoginFailure, recordLoginSuccess } from './rateLimit';
import { resolveClientAddress } from './requestClient';
import { writeAuditLog } from '../store/AuditStore';

/**
 * Thrown from the `jwt` callback when the token's principal may no longer hold
 * a session — missing, not `active`, or signed out by an epoch bump. NextAuth
 * turns the throw into "no session" for every `getServerSession` consumer and
 * clears the cookie on its own session route.
 */
class SessionRefusedError extends Error {
  constructor() {
    super('Session refused: the principal is no longer active');
    this.name = 'SessionRefusedError';
  }
}

/**
 * A valid cost-12 bcrypt hash of a throwaway string — the same cost as every
 * stored hash — compared against when the email is unknown or the record holds
 * no hash (a tombstone), so that path costs what a real compare costs.
 */
const DUMMY_PASSWORD_HASH = '$2b$12$D0q5piEtIifCQCqy0jjWx.01dayJ8hrVR1csHDvM4l7XcSzd1ohwm';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        name: { label: 'Name', type: 'text' },
        action: { label: 'Action', type: 'text' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;
        try {
          await assertSetupComplete();
        } catch (err) {
          if (err instanceof SetupRequiredError) return null;
          throw err;
        }

        // The limiter's two axes key on the RESOLVED client address (socket
        // peer, or a declared trusted proxy's forwarded hop) — never a header
        // the caller wrote — and on the submitted email.
        const client = resolveClientAddress((req?.headers ?? {}) as Record<string, string | undefined>);
        const ip = client.address;
        const email = credentials.email.toLowerCase().trim();
        const gate = beginLoginAttempt(email, ip);
        if (gate.kind !== 'proceed') {
          void writeAuditLog({ userId: null, action: 'login.rate_limited', details: { email, reason: gate.kind }, ip });
          return null;
        }
        if (gate.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, gate.waitMs));

        // Registration removed — user creation only via `pnpm setup` or admin API.
        // Every branch pays ONE bcrypt compare (a dummy hash when the email is
        // unknown), so the response time does not say whether an account
        // exists, and every refusal counts on the same axes.
        const existing = await findUserByEmail(email);
        const valid = await bcrypt.compare(credentials.password, existing?.passwordHash || DUMMY_PASSWORD_HASH);

        if (!existing) {
          void writeAuditLog({ userId: null, action: 'login.failed', details: { email, reason: 'not_found' }, ip });
          recordLoginFailure(email, ip);
          return null;
        }

        // Check user is active
        if (!isActiveUser(existing)) {
          void writeAuditLog({ userId: existing.id, userEmail: email, action: 'login.failed', details: { reason: existing.status }, ip });
          recordLoginFailure(email, ip);
          return null;
        }

        if (!valid) {
          void writeAuditLog({ userId: existing.id, userEmail: email, action: 'login.failed', details: { reason: 'invalid_password' }, ip });
          recordLoginFailure(email, ip);
          return null;
        }

        // Update last login timestamp
        await updateUser(existing.id, { lastLoginAt: new Date().toISOString() }).catch(() => {});
        recordLoginSuccess(email, ip);
        void writeAuditLog({ userId: existing.id, userEmail: email, action: 'login.success', ip });

        return {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          mustChangePassword: existing.mustChangePassword,
          sessionEpoch: sessionEpochOf(existing),
        };
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    // `sessionMaxAgeSeconds` platform key — restrict-only (max pinned at the
    // 30-day default, admins can only shorten). LAZY getter: `authOptions` is
    // a module-level literal evaluated before the config store registers, so a
    // direct read here would be boot-fatal; NextAuth reads the property per
    // request, by which time the store is up. Applies to newly issued tokens.
    get maxAge(): number {
      try {
        return Number(getPlatformConfigStore().get('sessionMaxAgeSeconds')) || 2_592_000;
      } catch {
        return 2_592_000;
      }
    },
  },
  secret: getEnv().auth.secret,
  pages: { signIn: '/auth' },
  logger: {
    // A refused principal's every request lands here as `JWT_SESSION_ERROR`;
    // that is the gate working, not a server error.
    error(code, metadata) {
      if (code === 'JWT_SESSION_ERROR' && metadata instanceof Error && metadata.name === 'SessionRefusedError') {
        getLogger().child('auth').info('session refused: principal no longer active');
        return;
      }
      console.error(`[next-auth][error][${code}]`, metadata);
    },
  },
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Allow relative URLs
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      // Allow same hostname across ports (MCP on 3101, app on 3100)
      try {
        const target = new URL(url);
        const base = new URL(baseUrl);
        if (target.hostname === base.hostname) return url;
      } catch { /* invalid URL — fall through to baseUrl */ }
      return baseUrl;
    },
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.email = user.email;
        token.name = user.name;
        token.mustChangePassword = (user as unknown as Record<string, unknown>).mustChangePassword ?? false;
        token.sessionEpoch = (user as unknown as Record<string, unknown>).sessionEpoch ?? 0;
      }
      // Every later request re-resolves the principal: a missing, disabled or
      // deleted user, or an epoch the record has moved past, gets NO session
      // (the ONE-producer rule — no consumer checks status itself). A read
      // error throws too: fail closed, at the cost of a re-login.
      // `mustChangePassword` is refreshed on the same read.
      if (token.userId && !user) {
        const record = await resolveActiveUser(token.userId as string, { sessionEpoch: token.sessionEpoch });
        if (!record) throw new SessionRefusedError();
        token.mustChangePassword = record.mustChangePassword;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const u = session.user as Record<string, unknown>;
        u.id = token.userId;
        u.mustChangePassword = token.mustChangePassword ?? false;
      }
      return session;
    },
  },
};

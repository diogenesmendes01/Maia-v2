/**
 * P8.5 — NextAuth v5 (auth.js) configuration.
 *
 * v1 uses a magic-link CredentialsProvider stub: lookup by email, no password
 * verification, no actual email sending. Email verification + SAML/OIDC
 * deferred to v1.1 / P10. The stub is gated behind `FEATURE_ADMIN_UI_V1=true`.
 */
import type { NextAuthOptions, Session, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import CredentialsProvider from 'next-auth/providers/credentials';
import { appUsersRepo } from '../../db/repositories.js';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: 'magic-link',
      name: 'Magic Link',
      credentials: {
        email: { label: 'Email', type: 'text' },
        token: { label: 'Token', type: 'text' },
        tenantId: { label: 'Tenant', type: 'text' },
      },
      async authorize(credentials): Promise<User | null> {
        if (!credentials?.email || !credentials?.tenantId) return null;
        const user = await appUsersRepo.getByEmail(credentials.tenantId, credentials.email);
        if (!user) return null;
        // TODO(P10): verify token via email_verification flow.
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          image: user.image ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }: { token: JWT; user?: User }): Promise<JWT> {
      if (user?.id) {
        const dbUser = await appUsersRepo.getById(user.id);
        if (dbUser) {
          token.id = dbUser.id;
          token.role = dbUser.role;
          token.tenant_id = dbUser.tenant_id;
        }
      }
      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }): Promise<Session> {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.tenant_id = token.tenant_id as string;
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  secret: process.env.NEXTAUTH_SECRET ?? 'dev-secret-change-in-prod',
};

// Module augmentation: extend the default Session.user shape with our
// tenant + role fields. NextAuth v5 supports declaration merging.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
      role: string;
      tenant_id: string;
    };
  }
}
declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
    tenant_id?: string;
  }
}

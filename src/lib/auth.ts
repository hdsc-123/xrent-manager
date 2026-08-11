import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string;
      role: string;
    } & DefaultSession["user"];
  }
}

interface ExtendedToken {
  id?: string;
  tenantId?: string;
  role?: string;
}

/**
 * Session strategy is JWT, not "database": NextAuth's CredentialsProvider
 * refuses to run under the "database" session strategy (throws
 * UnsupportedStrategy), so the DB-backed Session table isn't populated for
 * credentials logins. Account/Session/VerificationToken stay in the schema
 * so OAuth providers can be added later without a new migration.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string" ? credentials.email : undefined;
        const password =
          typeof credentials?.password === "string" ? credentials.password : undefined;

        if (!email || !password) {
          return null;
        }

        // Un email n'est unique que par tenant (@@unique([tenantId, email])) : en cas
        // d'email dupliqué entre tenants, ce lookup est ambigu — voir HANDOFF.md, point
        // À DÉCIDER sur la résolution du tenant à la connexion.
        const user = await prisma.user.findFirst({ where: { email } });

        if (!user?.passwordHash) {
          return null;
        }

        const isValidPassword = await bcrypt.compare(password, user.passwordHash);

        if (!isValidPassword) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenantId,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      return Boolean(user);
    },
    async jwt({ token, user }) {
      const extendedToken = token as typeof token & ExtendedToken;
      if (user) {
        extendedToken.id = user.id;
        extendedToken.tenantId = (user as { tenantId: string }).tenantId;
        extendedToken.role = (user as { role: string }).role;
      }
      return extendedToken;
    },
    async session({ session, token }) {
      const extendedToken = token as typeof token & ExtendedToken;
      if (
        session.user &&
        extendedToken.id &&
        extendedToken.tenantId &&
        extendedToken.role
      ) {
        session.user.id = extendedToken.id;
        session.user.tenantId = extendedToken.tenantId;
        session.user.role = extendedToken.role;
      }
      return session;
    },
  },
});

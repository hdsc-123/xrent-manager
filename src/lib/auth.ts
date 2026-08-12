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

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 jours ("se souvenir de moi" coché)
const SESSION_SHORT_MAX_AGE_SECONDS = 24 * 60 * 60; // 1 jour ("se souvenir de moi" décoché)

/**
 * Vérifie le mot de passe pour tous les users partageant cet email, tous tenants
 * confondus (Sprint 9, résolution du tenant à la connexion — Option B, HANDOFF.md point
 * 16). Le mot de passe est vérifié *avant* de révéler la liste des tenants, pour ne
 * jamais exposer l'appartenance multi-tenant d'un email sans preuve d'identité
 * (SECURITY.md section 3 : ne jamais distinguer compte inexistant / mot de passe invalide).
 */
export async function resolveLoginTenants(
  email: string,
  password: string
): Promise<{ id: string; name: string }[]> {
  const candidates = await prisma.user.findMany({
    where: { email },
    select: { tenantId: true, passwordHash: true, tenant: { select: { id: true, name: true } } },
  });

  const matches: { id: string; name: string }[] = [];
  for (const candidate of candidates) {
    if (!candidate.passwordHash) continue;
    const isValid = await bcrypt.compare(password, candidate.passwordHash);
    if (isValid) {
      matches.push({ id: candidate.tenant.id, name: candidate.tenant.name });
    }
  }

  return matches;
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
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        tenantId: { label: "Tenant", type: "text" },
        rememberMe: { label: "Remember me", type: "text" },
      },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string" ? credentials.email : undefined;
        const password =
          typeof credentials?.password === "string" ? credentials.password : undefined;
        const tenantId =
          typeof credentials?.tenantId === "string" && credentials.tenantId
            ? credentials.tenantId
            : undefined;
        const rememberMe = credentials?.rememberMe === "true";

        if (!email || !password) {
          return null;
        }

        // Un email n'est unique que par tenant (@@unique([tenantId, email])). Si tenantId
        // est fourni (résolution explicite, Sprint 9), lookup non ambigu ; sinon findFirst
        // (cas non ambigu où l'email n'existe que dans un seul tenant).
        const user = tenantId
          ? await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } })
          : await prisma.user.findFirst({ where: { email } });

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
          rememberMe,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      return Boolean(user);
    },
    async jwt({ token, user, trigger }) {
      const extendedToken = token as typeof token & ExtendedToken;
      if (user) {
        extendedToken.id = user.id;
        extendedToken.tenantId = (user as { tenantId: string }).tenantId;
        extendedToken.role = (user as { role: string }).role;
        const rememberMe = (user as { rememberMe?: boolean }).rememberMe;
        const maxAge = rememberMe === false ? SESSION_SHORT_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS;
        extendedToken.exp = Math.floor(Date.now() / 1000) + maxAge;
      }

      // Rafraîchissement de session (Sprint 11, HANDOFF.md point 35) : déclenché par
      // useSession().update() côté client après édition du profil (voir EditProfileForm.tsx).
      // Le nom/email est relu directement en base par id de token, jamais accepté depuis le
      // payload client de l'update, pour ne jamais faire confiance à des données non validées
      // côté serveur (seul le PATCH /api/users/me authentifié est source de vérité).
      if (trigger === "update" && extendedToken.id) {
        const current = await prisma.user.findUnique({
          where: { id: extendedToken.id },
          select: { name: true, email: true },
        });
        if (current) {
          extendedToken.name = current.name;
          extendedToken.email = current.email;
        }
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

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * `middleware.ts` est déprécié dans cette version de Next.js et renommé `proxy.ts`
 * (voir node_modules/next/dist/docs/.../file-conventions/proxy.md) — même comportement,
 * seul le nom change. Vérification "optimiste" uniquement (lecture du JWT côté cookie,
 * pas de requête base de données) — voir guide Next.js sur l'authentification :
 * la vérification faisant autorité reste à faire dans chaque route/Server Action.
 */
const protectedPrefixes = ["/dashboard", "/settings"];

export default auth((req) => {
  const isProtectedRoute = protectedPrefixes.some((prefix) =>
    req.nextUrl.pathname.startsWith(prefix)
  );

  if (isProtectedRoute && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/settings/:path*"],
};

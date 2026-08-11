import { TEST_BASE_URL } from "./testServer";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${TEST_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/**
 * Extrait le cookie de session NextAuth (`authjs.session-token` ou sa variante
 * `__Secure-`) d'une réponse, prêt à être renvoyé tel quel dans un header `Cookie`.
 */
export function extractSessionCookie(response: Response): string | undefined {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);

  const sessionCookie = setCookieHeaders.find((cookie) => cookie.includes("session-token="));
  return sessionCookie?.split(";")[0];
}

export function findSetCookie(response: Response, nameFragment: string): string | undefined {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);

  return setCookieHeaders.find((cookie) => cookie.includes(nameFragment));
}

export class ApiError extends Error {
  status: number;
  /** Corps JSON complet de la réponse d'erreur (ex. { duplicate } sur un 409 doublon client). */
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Wrapper fetch pour les routes internes /api/*. Toutes ces routes renvoient
 * `{ error: string }` en cas d'échec (voir src/app/api/**), donc ce wrapper
 * normalise la levée d'erreur pour que les pages n'aient qu'à afficher `err.message`.
 */
export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Erreur ${response.status}.`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

export function apiGet<T>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "GET" });
}

export function apiPost<T>(url: string, data: unknown): Promise<T> {
  return apiFetch<T>(url, { method: "POST", body: JSON.stringify(data) });
}

export function apiPatch<T>(url: string, data: unknown): Promise<T> {
  return apiFetch<T>(url, { method: "PATCH", body: JSON.stringify(data) });
}

export function apiDelete<T>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "DELETE" });
}

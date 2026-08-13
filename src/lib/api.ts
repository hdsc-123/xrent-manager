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

/**
 * POST dont la réponse réussie est un fichier binaire (ex. PDF de lot, Sprint 14B) plutôt que
 * du JSON — apiFetch ci-dessus suppose toujours du JSON, y compris pour les erreurs, donc
 * inutilisable ici. Déclenche le téléchargement via un lien <a> temporaire.
 */
export async function apiPostDownload(url: string, data: unknown, filename: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    let message = `Erreur ${response.status}.`;
    try {
      const body = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // réponse d'erreur non-JSON — on garde le message générique.
    }
    throw new ApiError(message, response.status);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

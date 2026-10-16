export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

export interface ApiFetchDeps {
  getToken(): Promise<string | null>;
  onUnauthorized(): void;
  /** 403: signed in, but the account is not on the API allowlist. */
  onForbidden?(): void;
  fetchImpl?: typeof fetch;
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Calls the API through the same-origin `/api` proxy with the user's token. */
export function createApiFetch(deps: ApiFetchDeps) {
  return async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await deps.getToken();
    if (!token) {
      deps.onUnauthorized();
      throw new ApiError(401, null);
    }

    const hasBody = init.body !== undefined;
    const response = await (deps.fetchImpl ?? fetch)(`/api${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(hasBody && { "content-type": "application/json" }) },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const body = parse(await response.text());

    if (response.status === 401) {
      deps.onUnauthorized();
      throw new ApiError(401, body);
    }
    if (response.status === 403) {
      deps.onForbidden?.();
      throw new ApiError(403, body);
    }
    if (!response.ok) throw new ApiError(response.status, body);
    return body as T;
  };
}

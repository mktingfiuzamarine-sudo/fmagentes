export interface HealthStatus {
  supabase: string;
  redis: string;
  evolutionApi: string;
}

/** The Status page renders on the server: a hung API must not hang it. */
export const HEALTH_TIMEOUT_MS = 5000;

export async function getHealth(apiUrl: string | undefined, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthStatus | null> {
  if (!apiUrl) {
    return null;
  }

  try {
    const response = await fetch(`${apiUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    // 503 still carries the per-service report; anything else (e.g. 429) does not.
    if (response.status !== 200 && response.status !== 503) return null;
    return (await response.json()) as HealthStatus;
  } catch {
    return null;
  }
}

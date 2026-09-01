export interface HealthStatus {
  supabase: string;
  redis: string;
  evolutionApi: string;
}

export async function getHealth(apiUrl: string | undefined): Promise<HealthStatus | null> {
  if (!apiUrl) {
    return null;
  }

  try {
    const response = await fetch(`${apiUrl}/health`, { cache: "no-store" });
    return (await response.json()) as HealthStatus;
  } catch {
    return null;
  }
}

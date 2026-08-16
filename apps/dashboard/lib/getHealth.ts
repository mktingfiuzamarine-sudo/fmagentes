export interface HealthStatus {
  supabase: string;
  redis: string;
  evolutionApi: string;
}

export async function getHealth(apiUrl: string): Promise<HealthStatus | null> {
  try {
    const response = await fetch(`${apiUrl}/health`, { cache: "no-store" });
    return (await response.json()) as HealthStatus;
  } catch {
    return null;
  }
}

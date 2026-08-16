import { getHealth } from "../../lib/getHealth";

export default async function DashboardPage() {
  const health = await getHealth(process.env.NEXT_PUBLIC_API_URL!);

  return (
    <main>
      <h1>Status do sistema</h1>
      {health ? (
        <ul>
          <li>Supabase: {health.supabase}</li>
          <li>Redis: {health.redis}</li>
          <li>Evolution API: {health.evolutionApi}</li>
        </ul>
      ) : (
        <p>Não foi possível conectar à API.</p>
      )}
    </main>
  );
}

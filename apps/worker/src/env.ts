import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

export const envSchema = z.object({
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  // The CRM is a separate Supabase project, reached with its service key.
  CRM_SUPABASE_URL: z.string().url(),
  CRM_SUPABASE_SERVICE_KEY: z.string().min(1),
  // Auth id of the human CRM user who owns clients the agent creates.
  CRM_AGENT_USER_ID: z.string().uuid(),
  // Optional per provider: an agent on a provider without a key fails as misconfigured.
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  AGENT_HISTORY_LIMIT: z.coerce.number().int().min(1).max(200).default(30),
});

export const loadEnv = createEnvLoader(envSchema);
export type Env = ReturnType<typeof loadEnv>;

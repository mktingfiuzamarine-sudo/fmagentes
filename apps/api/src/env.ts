import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  API_PORT: z.coerce.number().default(3001),
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  PUBLIC_WEBHOOK_URL: z.string().url(),
  // Comma-separated emails or Supabase user ids allowed to call the consumer
  // routes. Required and non-empty: an absent allowlist must not mean "anyone".
  API_ALLOWED_USERS: z.string().min(1),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;

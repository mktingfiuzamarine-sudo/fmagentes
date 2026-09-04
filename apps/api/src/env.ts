import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  API_PORT: z.coerce.number().default(3001),
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  PUBLIC_WEBHOOK_URL: z.string().url(),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;

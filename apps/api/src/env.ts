import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const emptyAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), inner);

const schema = z.object({
  API_PORT: z.coerce.number().default(3001),
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  // Optional: only used to tell the dashboard which providers are usable.
  // An empty `KEY=` line counts as absent.
  ANTHROPIC_API_KEY: emptyAsAbsent(z.string().optional()),
  OPENAI_API_KEY: emptyAsAbsent(z.string().optional()),
  // Optional CRM access (customer names in the inbox). Both or neither.
  CRM_SUPABASE_URL: emptyAsAbsent(z.string().url().optional()),
  CRM_SUPABASE_SERVICE_KEY: emptyAsAbsent(z.string().min(1).optional()),
  WEBHOOK_SECRET: z.string().min(1),
  PUBLIC_WEBHOOK_URL: z.string().url(),
  // Comma-separated emails or Supabase user ids allowed to call the consumer
  // routes. Required and non-empty: an absent allowlist must not mean "anyone".
  API_ALLOWED_USERS: z.string().min(1),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;

import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  REDIS_URL: z.string().url(),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;

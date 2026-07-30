import { config as loadDotenv } from "dotenv";
import type { ZodTypeAny, z } from "zod";

loadDotenv();

export function createEnvLoader<T extends ZodTypeAny>(schema: T): () => z.infer<T> {
  let cached: z.infer<T> | undefined;

  return function loadEnv(): z.infer<T> {
    if (cached) return cached;

    const result = schema.safeParse(process.env);

    if (!result.success) {
      const formatted = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      console.error(`Invalid environment variables:\n${formatted}`);
      process.exit(1);
    }

    cached = result.data;
    return cached;
  };
}

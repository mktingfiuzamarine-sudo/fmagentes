import { z } from "zod";

/** A copy of a plain object without its null entries; anything else passes through. */
export function dropNulls(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

/**
 * Tool parameters that read a null field as absent. Models (gpt-4o-mini) send
 * `"campo": null` for optional fields they have no value for; a plain object
 * schema refuses it and the whole turn fails, leaving the customer unanswered.
 */
export function toolArgs<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(dropNulls, z.object(shape));
}

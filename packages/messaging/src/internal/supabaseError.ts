/**
 * Throw a plain Error carrying the Supabase error message when a
 * PostgREST call returns a non-null `error`. Shared by the messaging
 * domain operations so route handlers can map failures uniformly.
 */
export function assertNoError(error: unknown): void {
  if (error) {
    const message =
      typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : "Supabase error";
    throw new Error(message);
  }
}

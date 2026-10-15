const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path params are checked before querying, so a bad id is a 404, not a cast error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

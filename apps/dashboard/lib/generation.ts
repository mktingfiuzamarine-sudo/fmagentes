/**
 * Tags async work with the generation it started in, so an answer that
 * arrives after the subject changed (another tab, another conversation) is
 * dropped instead of overwriting the current one.
 */
export function createGeneration() {
  let value = 0;
  return {
    current: () => value,
    advance: () => ++value,
    isCurrent: (generation: number) => generation === value,
  };
}

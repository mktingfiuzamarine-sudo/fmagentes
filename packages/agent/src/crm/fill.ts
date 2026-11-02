export interface FillPlan {
  patch: Record<string, unknown>;
  filled: string[];
  conflicts: string[];
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Decide o que a IA pode gravar: só campos vazios entram no patch; valores diferentes
 * dos já salvos viram uma linha em `notes` (sem repetir), nunca sobrescrevem.
 */
export function planFill(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  labels: Record<string, string>,
  notes: string | null,
): FillPlan {
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];
  const conflicts: string[] = [];
  let nextNotes = notes ?? "";
  let notesChanged = false;

  for (const [field, value] of Object.entries(incoming)) {
    if (isBlank(value)) continue;
    if (isBlank(current[field])) {
      patch[field] = value;
      filled.push(field);
      continue;
    }
    if (same(current[field], value)) continue;
    conflicts.push(field);
    const line = `Cliente informou ${labels[field] ?? field} diferente: ${String(value).trim()}`;
    if (nextNotes.split("\n").includes(line)) continue;
    nextNotes = nextNotes ? `${nextNotes}\n${line}` : line;
    notesChanged = true;
  }

  if (notesChanged) patch.notes = nextNotes;
  return { patch, filled, conflicts };
}

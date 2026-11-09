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

/** Máximo de caracteres do valor citado numa linha de observação. */
const NOTE_VALUE_MAX = 200;

/** Uma linha só e no máximo NOTE_VALUE_MAX caracteres: o valor vem do cliente. */
function noteValue(value: unknown): string {
  const oneLine = String(value).replace(/\s+/g, " ").trim();
  return oneLine.length > NOTE_VALUE_MAX ? `${oneLine.slice(0, NOTE_VALUE_MAX)}…` : oneLine;
}

/**
 * Decide o que a IA pode gravar: só campos vazios entram no patch; valores diferentes
 * dos já salvos viram uma linha em `notes` (sem repetir), nunca sobrescrevem.
 * `extraLines` entram em `notes` do mesmo jeito (uma linha, sem repetir).
 */
export function planFill(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  labels: Record<string, string>,
  notes: string | null,
  extraLines: readonly string[] = [],
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
    const line = `Cliente informou ${labels[field] ?? field} diferente: ${noteValue(value)}`;
    if (nextNotes.split("\n").includes(line)) continue;
    nextNotes = nextNotes ? `${nextNotes}\n${line}` : line;
    notesChanged = true;
  }

  for (const raw of extraLines) {
    const line = noteValue(raw);
    if (!line || nextNotes.split("\n").includes(line)) continue;
    nextNotes = nextNotes ? `${nextNotes}\n${line}` : line;
    notesChanged = true;
  }

  if (notesChanged) patch.notes = nextNotes;
  return { patch, filled, conflicts };
}

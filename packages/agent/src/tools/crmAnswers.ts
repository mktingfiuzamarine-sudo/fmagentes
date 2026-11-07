import { CrmNotInScopeError, type FillResult } from "../crm/CrmPort";

/** Same answer for a missing record, one outside the scope and a malformed id: it reveals nothing. */
export const NOT_FOUND_ANSWER = "Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento.";
export const NOTHING_TO_SAVE_ANSWER = "Nada novo para salvar.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Trimmed text, or undefined when blank. */
export function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_SIZE = 99_999;

/**
 * Collects values the CRM would refuse (year outside 1900-2100, size <= 0, malformed text) so the tool
 * drops them instead of failing the whole turn, and can tell the model which ones were left out.
 */
export class FieldGuard {
  private readonly rejected: string[] = [];

  constructor(private readonly labels: Record<string, string>) {}

  private reject(field: string): undefined {
    this.rejected.push(this.labels[field] ?? field);
    return undefined;
  }

  /** Integer year between 1900 and 2100. */
  year(field: string, value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    return Number.isInteger(value) && value >= 1900 && value <= 2100 ? value : this.reject(field);
  }

  /** Positive number (length, horsepower). */
  positive(field: string, value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    return Number.isFinite(value) && value > 0 && value <= MAX_SIZE ? value : this.reject(field);
  }

  /** Trimmed text that passes `valid`. */
  text(field: string, value: string | undefined, valid: (v: string) => boolean): string | undefined {
    const t = text(value);
    if (t === undefined) return undefined;
    return valid(t) ? t : this.reject(field);
  }

  /** Suffix for the tool answer; empty when nothing was dropped. */
  suffix(): string {
    return this.rejected.length === 0 ? "" : ` Não salvo por estar fora do esperado: ${this.rejected.join(", ")}.`;
  }
}

/** Labels of the conflicting columns only; never the stored values. */
export function savedAnswer(result: FillResult, labels: Record<string, string>): string {
  if (result.conflicts.length === 0) return "Salvo.";
  const names = result.conflicts.map((id) => labels[id] ?? id).join(", ");
  return `Salvo. Já havia outro valor salvo para: ${names}; a equipe vai conferir.`;
}

/** Runs a CRM call; only an out-of-scope error becomes the neutral answer, anything else retries the job. */
export async function orNotFound(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CrmNotInScopeError) return NOT_FOUND_ANSWER;
    throw error;
  }
}

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

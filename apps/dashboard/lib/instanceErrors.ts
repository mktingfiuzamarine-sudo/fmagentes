import { ApiError } from "./api";

/** What the attendant reads when creating a number fails. */
export function createInstanceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return "Use só letras, números, - e _ no nome (até 64 caracteres).";
    if (error.status === 409) return "A Evolution recusou o nome: ele provavelmente já está em uso.";
    if (error.status === 502) return "A Evolution API não respondeu.";
  }
  return "Não foi possível criar o número.";
}

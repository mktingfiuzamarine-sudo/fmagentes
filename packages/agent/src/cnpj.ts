import { isValidCpf, normalizeCpf } from "./cpf";

/** Brazilian CNPJ: 14 digits, not all equal, both check digits correct. */
export function isValidCnpj(input: string): boolean {
  const digits = normalizeCpf(input);
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;

  const checkDigit = (weights: number[]): number => {
    const sum = weights.reduce((acc, weight, i) => acc + Number(digits[i]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  return (
    checkDigit([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[12]) &&
    checkDigit([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(digits[13])
  );
}

/** Accepts a valid CPF (11 digits) or a valid CNPJ (14 digits). */
export function isValidCpfOrCnpj(input: string): boolean {
  return isValidCpf(input) || isValidCnpj(input);
}

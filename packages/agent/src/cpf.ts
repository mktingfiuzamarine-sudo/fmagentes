export function normalizeCpf(input: string): string {
  return input.replace(/\D/g, "");
}

/** Brazilian CPF: 11 digits, not all equal, both check digits correct. */
export function isValidCpf(input: string): boolean {
  const digits = normalizeCpf(input);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const checkDigit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}

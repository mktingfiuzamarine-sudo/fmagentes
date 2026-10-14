const MIN_NATIONAL_DIGITS = 10;

/** Brazilian 8-digit local numbers starting 6-9 are mobiles; 2-5 are landlines. */
const isMobileLocal = (local: string) => /^[6-9]/.test(local);

/**
 * Suffixes a CRM `phone_digits` may end with for this WhatsApp number.
 * WhatsApp gives 55 + DDD + number; CRM phones are typed by hand, with or
 * without country code and with or without the mobile ninth digit. The ninth
 * digit is only added or stripped for mobile-shaped numbers: a landline
 * variant could be a different person. Too-short numbers return [] so a tiny
 * suffix never matches half the CRM.
 */
export function phoneMatchSuffixes(whatsappPhone: string): string[] {
  const digits = whatsappPhone.replace(/\D/g, "");
  const isBrazilian = digits.startsWith("55") && digits.length >= 12;
  const national = isBrazilian ? digits.slice(2) : digits;
  if (national.length < MIN_NATIONAL_DIGITS) return [];
  if (!isBrazilian) return [national];

  const ddd = national.slice(0, 2);
  if (national.length === 11 && national[2] === "9" && isMobileLocal(national.slice(3))) {
    return [national, ddd + national.slice(3)];
  }
  if (national.length === 10 && isMobileLocal(national.slice(2))) return [national, `${ddd}9${national.slice(2)}`];
  return [national];
}

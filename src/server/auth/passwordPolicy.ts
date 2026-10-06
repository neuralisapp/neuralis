/** Password complexity validation. */

export type PasswordValidationResult = { valid: true } | { valid: false; reason: string };

export function validatePasswordComplexity(password: string): PasswordValidationResult {
  if (password.length < 12) return { valid: false, reason: 'Password must be at least 12 characters' };
  if (!/[A-Z]/.test(password)) return { valid: false, reason: 'Password must contain an uppercase letter' };
  if (!/[a-z]/.test(password)) return { valid: false, reason: 'Password must contain a lowercase letter' };
  if (!/[0-9]/.test(password)) return { valid: false, reason: 'Password must contain a number' };
  if (!/[^A-Za-z0-9]/.test(password)) return { valid: false, reason: 'Password must contain a special character' };
  return { valid: true };
}

import { describe, it, expect } from 'vitest';
import { validatePasswordComplexity } from '../passwordPolicy';

describe('validatePasswordComplexity', () => {
  it('rejects short password', () => {
    const result = validatePasswordComplexity('Ab1!short');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('12 characters');
  });

  it('rejects missing uppercase', () => {
    const result = validatePasswordComplexity('abcdefghijk1!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('uppercase');
  });

  it('rejects missing lowercase', () => {
    const result = validatePasswordComplexity('ABCDEFGHIJK1!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('lowercase');
  });

  it('rejects missing number', () => {
    const result = validatePasswordComplexity('Abcdefghijk!!');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('number');
  });

  it('rejects missing special character', () => {
    const result = validatePasswordComplexity('Abcdefghijk12');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('special');
  });

  it('accepts valid password', () => {
    const result = validatePasswordComplexity('MyP@ssw0rd123');
    expect(result.valid).toBe(true);
  });

  it('accepts exactly 12 chars', () => {
    const result = validatePasswordComplexity('Ab1!efghijkl');
    expect(result.valid).toBe(true);
  });

  it('accepts password with unicode', () => {
    const result = validatePasswordComplexity('Abcdefghijk1!é');
    expect(result.valid).toBe(true);
  });

  it('accepts password with spaces', () => {
    const result = validatePasswordComplexity('My Pass w0rd!');
    expect(result.valid).toBe(true);
  });
});

/**
 * CredentialUseRules — the owner-managed credential-use rule table
 * (credential-use limits v1).
 *
 * One JSON file `{appRoot}/credentials/credential-use-rules.json` mapping
 * credentialId → `{ maxCalls, period }`. Rules are per-credential-id and
 * platform-GLOBAL in v1 (the check sums the id across every scope; per-scope
 * rules are a v2 question). EXACT-id matching only: a rule on
 * `telegram.botToken` does NOT match a derived
 * `telegram.botToken.<connectionId>` row — derived ids are their own catalog
 * entries and take their own rules.
 *
 * A separate file (not CredentialStore metadata) because credential records
 * are bare EncryptedPayloads — the store has no metadata concept, and rules
 * are not secrets.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { durableReplaceFile } from '@neuralis/package-system/data';
import {
  isValidCredentialId,
  type CredentialUseRule,
  type SpendPeriod,
} from '@neuralis/package-system/contracts';

const PERIODS: readonly SpendPeriod[] = ['day', 'week', 'month'];

export class CredentialUseRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialUseRuleError';
  }
}

/** Closed-shape validation: `{maxCalls: int ≥ 1, period ∈ day|week|month}`. */
export function validateCredentialUseRule(value: unknown): CredentialUseRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialUseRuleError('Rule must be an object { maxCalls, period }');
  }
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of keys) {
    if (key !== 'maxCalls' && key !== 'period') {
      throw new CredentialUseRuleError(`Unknown rule key: ${key}`);
    }
  }
  const { maxCalls, period } = value as { maxCalls?: unknown; period?: unknown };
  if (typeof maxCalls !== 'number' || !Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new CredentialUseRuleError('maxCalls must be an integer >= 1');
  }
  if (typeof period !== 'string' || !PERIODS.includes(period as SpendPeriod)) {
    throw new CredentialUseRuleError('period must be one of day | week | month');
  }
  return { maxCalls, period: period as SpendPeriod };
}

export class CredentialUseRules {
  readonly #file: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(appRoot: string) {
    this.#file = join(appRoot, 'credentials', 'credential-use-rules.json');
  }

  async #readAll(): Promise<Record<string, CredentialUseRule>> {
    try {
      const raw = await readFile(this.#file, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, CredentialUseRule> = {};
      for (const [id, rule] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isValidCredentialId(id)) continue;
        try {
          out[id] = validateCredentialUseRule(rule);
        } catch {
          // A malformed persisted row is dropped on read (never enforced as
          // garbage, never crashes the resolver floor).
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  async list(): Promise<Record<string, CredentialUseRule>> {
    return this.#readAll();
  }

  async get(credentialId: string): Promise<CredentialUseRule | null> {
    const all = await this.#readAll();
    return all[credentialId] ?? null;
  }

  /**
   * Set (rule object) or clear (`null`) one credential's rule. Validates the
   * closed shape and the id; writes serialize through one chain.
   */
  async set(credentialId: string, rule: CredentialUseRule | null): Promise<void> {
    if (!isValidCredentialId(credentialId)) {
      throw new CredentialUseRuleError(`Invalid credential id: ${credentialId}`);
    }
    const validated = rule === null ? null : validateCredentialUseRule(rule);
    const next = this.#writeChain.then(async () => {
      const all = await this.#readAll();
      if (validated === null) {
        delete all[credentialId];
      } else {
        all[credentialId] = validated;
      }
      await durableReplaceFile(this.#file, JSON.stringify(all, null, 2), { mode: 0o600 });
    });
    this.#writeChain = next.catch(() => {});
    return next;
  }
}

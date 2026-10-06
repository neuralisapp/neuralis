/**
 * credentialUseGate — the ONE gate body of credential-use limits v1.
 *
 * Applied by the host bootstrap at the FOUR resolve choke points (the package
 * `ctx.credentials` resolver, both ConfigProvider `getCredential` closures,
 * `mcpTokenStore.readScoped`) and exposed to packages as the
 * `CredentialUsePort`. Check → deny ⇒ audit `credential.use_denied` + return
 * `undefined`; a VALUE-returning resolve records one use (a miss is not a
 * use). The gate must never hard-break a resolve: rule/usage read errors read
 * as unlimited/zero and a failed record is logged, not thrown.
 *
 * LLM provider keys are EXCLUDED (owner decision, v1): the set is DERIVED from
 * FIRST-PARTY manifest `credentials[]` declarations with `category === 'llm'`
 * — never hand-typed. SECURITY FLOOR: derive from first-party manifests ONLY —
 * `category` is display metadata any manifest can set, and an untrusted
 * `_packages/` drop declaring `category:'llm'` on a counted id must not exempt
 * it (the caller passes the builtin set, which is first-party by source).
 */

import {
  windowDates,
  type CredentialUsePort,
  type CredentialUseVerdict,
  type PackageDefinition,
} from '@neuralis/package-system/contracts';
import type { CredentialUsageStore } from '../store/CredentialUsageStore';
import type { CredentialUseRules } from '../store/CredentialUseRules';

export type CredentialUseAuditSink = (event: {
  action: string;
  userId: string;
  target?: string;
  details?: Record<string, unknown>;
}) => void;

/** Derive the v1-excluded id set from FIRST-PARTY package definitions. */
export function deriveLlmExcludedIds(firstPartyPackages: readonly PackageDefinition[]): Set<string> {
  const excluded = new Set<string>();
  for (const pkg of firstPartyPackages) {
    for (const cred of pkg.credentials ?? []) {
      if (cred.category === 'llm' && cred.id) excluded.add(cred.id);
    }
  }
  return excluded;
}

export type CredentialUseGate = {
  port: CredentialUsePort;
  excludedIds: Set<string>;
  /**
   * Wrap one credential read: pre-flight rule check (deny ⇒ audit +
   * `undefined`), then record iff the underlying resolve returned a value.
   */
  gatedRead(
    credentialId: string,
    attribution: { scopeKey: string; userId?: string },
    doResolve: () => Promise<string | undefined>,
  ): Promise<string | undefined>;
};

export function buildCredentialUseGate(deps: {
  usage: CredentialUsageStore;
  rules: CredentialUseRules;
  excludedIds: Set<string>;
  onAudit: CredentialUseAuditSink;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}): CredentialUseGate {
  const { usage, rules, excludedIds, onAudit } = deps;
  const warn = deps.warn ?? (() => {});

  const check = async (credentialId: string): Promise<CredentialUseVerdict> => {
    if (excludedIds.has(credentialId)) return { allowed: true };
    const rule = await rules.get(credentialId);
    if (!rule) return { allowed: true };
    const used = await usage.getUseTotal(credentialId, windowDates(rule.period));
    if (used >= rule.maxCalls) {
      return {
        allowed: false,
        reason: `Credential use limit reached (${rule.maxCalls}/${rule.period})`,
        limit: rule.maxCalls,
        used,
      };
    }
    return { allowed: true };
  };

  const record = (credentialId: string, opts?: { scopeKey?: string; calls?: number }): Promise<void> => {
    if (excludedIds.has(credentialId)) return Promise.resolve();
    return usage.record(credentialId, opts).catch((err) => {
      warn('[credential-use] record failed', {
        credentialId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const gatedRead = async (
    credentialId: string,
    attribution: { scopeKey: string; userId?: string },
    doResolve: () => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    if (!excludedIds.has(credentialId)) {
      const verdict = await check(credentialId);
      if (!verdict.allowed) {
        onAudit({
          action: 'credential.use_denied',
          userId: attribution.userId ?? '__system__',
          target: credentialId,
          details: { scopeKey: attribution.scopeKey, limit: verdict.limit, used: verdict.used },
        });
        return undefined;
      }
    }
    const value = await doResolve();
    if (value && !excludedIds.has(credentialId)) {
      await record(credentialId, { scopeKey: attribution.scopeKey });
    }
    return value;
  };

  return { port: { check, record }, excludedIds, gatedRead };
}

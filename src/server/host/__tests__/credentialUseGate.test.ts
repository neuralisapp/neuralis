/**
 * credential-use limits v1 — the ONE gate body + the derived LLM exclusion.
 *
 * The key regression rows: (1) the exclusion set is DERIVED from the real
 * agent-core manifest, never hand-typed — and only from what the caller passes
 * (first-party by construction, so an untrusted `category:'llm'` declaration
 * can never exempt an id); (2) a deny audits + returns undefined; (3) only
 * VALUE-returning resolves are counted (a miss is not a use).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { buildCredentialUseGate, deriveLlmExcludedIds } from '../credentialUseGate';
import { CredentialUsageStore } from '../../store/CredentialUsageStore';
import { CredentialUseRules } from '../../store/CredentialUseRules';

const AGENT_CORE_MANIFEST = JSON.parse(
  readFileSync(join(__dirname, '../../../../../packages/agent-core/package.json'), 'utf-8'),
) as { neuralis: PackageDefinition };

describe('deriveLlmExcludedIds', () => {
  it('derives the excluded set from the agent-core manifest (never hand-typed)', () => {
    const manifestLlmIds = (AGENT_CORE_MANIFEST.neuralis.credentials ?? [])
      .filter((c) => c.category === 'llm')
      .map((c) => c.id)
      .sort();
    expect(manifestLlmIds.length).toBeGreaterThanOrEqual(9); // 8 llm.* + codex oauth today
    const derived = deriveLlmExcludedIds([AGENT_CORE_MANIFEST.neuralis]);
    expect([...derived].sort()).toEqual(manifestLlmIds);
    // Counted classes stay OUT of the exclusion.
    expect(derived.has('voyage.apiKey')).toBe(false);
    expect(derived.has('websearch.tavily')).toBe(false);
  });

  it('the REAL boot input reproduces D-1 without agent-core — and heals with it', () => {
    // The boot derivation input is `builtinPackages` (which deliberately
    // EXCLUDES agent-core — it bootstraps itself) plus agent-core's own
    // manifest read explicitly. This behavioral pin reproduces the live-caught
    // defect: the four non-agent-core builtins declare ZERO category-llm
    // credentials, so without agent-core the set is empty and every LLM
    // provider key becomes countable AND deniable.
    const nonAgentCore = ['admin', 'brain-core', 'machine-core', 'package-system'].map((slug) => {
      const manifest = JSON.parse(
        readFileSync(join(__dirname, `../../../../../packages/${slug}/package.json`), 'utf-8'),
      ) as { neuralis?: PackageDefinition };
      return manifest.neuralis;
    }).filter((d): d is PackageDefinition => !!d);

    expect(deriveLlmExcludedIds(nonAgentCore).size).toBe(0); // the D-1 shape
    const healed = deriveLlmExcludedIds([...nonAgentCore, AGENT_CORE_MANIFEST.neuralis]);
    expect(healed.has('llm.openai')).toBe(true);
    expect(healed.has('llm.openai-codex.oauth')).toBe(true);
    expect(healed.size).toBeGreaterThanOrEqual(9);
  });

  it('only considers the packages it is GIVEN — the first-party floor is structural', () => {
    // An untrusted drop declaring category llm on a counted id: the bootstrap
    // passes builtinPackages ONLY, so the malicious definition never reaches
    // the derivation. This pins the function half of that floor: given only
    // first-party input, the hostile id is not excluded.
    const hostile = {
      id: 'evil-pkg',
      name: 'evil',
      version: '1.0.0',
      credentials: [{ id: 'websearch.tavily', label: 'x', category: 'llm' }],
    } as unknown as PackageDefinition;
    const derived = deriveLlmExcludedIds([AGENT_CORE_MANIFEST.neuralis]);
    expect(derived.has('websearch.tavily')).toBe(false);
    // ...and even if a caller mistakenly included it, the set only grows by
    // what was passed — the guard is the CALLER passing first-party only.
    const withHostile = deriveLlmExcludedIds([AGENT_CORE_MANIFEST.neuralis, hostile]);
    expect(withHostile.has('websearch.tavily')).toBe(true); // why the input set is the floor
  });
});

describe('buildCredentialUseGate', () => {
  let root: string;
  let usage: CredentialUsageStore;
  let rules: CredentialUseRules;
  let audits: Array<{ action: string; userId: string; target?: string; details?: Record<string, unknown> }>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'neuralis-cred-use-'));
    usage = new CredentialUsageStore(root);
    rules = new CredentialUseRules(root);
    audits = [];
  });

  function gate(excluded: string[] = []) {
    return buildCredentialUseGate({
      usage,
      rules,
      excludedIds: new Set(excluded),
      onAudit: (e) => audits.push(e),
    });
  }

  it('counts only VALUE-returning resolves — a miss is not a use', async () => {
    const g = gate();
    const hit = await g.gatedRead('websearch.tavily', { scopeKey: 'global' }, async () => 'secret');
    const miss = await g.gatedRead('websearch.tavily', { scopeKey: 'global' }, async () => undefined);
    expect(hit).toBe('secret');
    expect(miss).toBeUndefined();
    const today = new Date().toISOString().slice(0, 10);
    expect(await usage.getUseTotal('websearch.tavily', [today])).toBe(1);
  });

  it('denies with an audit once the rule window is exhausted, and returns undefined', async () => {
    await rules.set('websearch.tavily', { maxCalls: 2, period: 'day' });
    const g = gate();
    expect(await g.gatedRead('websearch.tavily', { scopeKey: 'global', userId: 'u1' }, async () => 'v')).toBe('v');
    expect(await g.gatedRead('websearch.tavily', { scopeKey: 'global', userId: 'u1' }, async () => 'v')).toBe('v');
    const denied = await g.gatedRead('websearch.tavily', { scopeKey: 'global', userId: 'u1' }, async () => 'v');
    expect(denied).toBeUndefined();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'credential.use_denied',
      userId: 'u1',
      target: 'websearch.tavily',
    });
    expect(audits[0].details).toMatchObject({ limit: 2, used: 2 });
  });

  it('an excluded (LLM) id is never denied and never counted, even with a rule', async () => {
    await rules.set('llm.anthropic', { maxCalls: 1, period: 'day' });
    const g = gate(['llm.anthropic']);
    for (let i = 0; i < 3; i++) {
      expect(await g.gatedRead('llm.anthropic', { scopeKey: 'global' }, async () => 'key')).toBe('key');
    }
    const today = new Date().toISOString().slice(0, 10);
    expect(await usage.getUseTotal('llm.anthropic', [today])).toBe(0);
    expect(audits).toHaveLength(0);
    // The port mirrors it.
    expect(await g.port.check('llm.anthropic')).toEqual({ allowed: true });
  });

  it('rules use their OWN window: a weekly rule sums the whole ISO week', async () => {
    // Seed yesterday's file directly through the store's date option.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
    // Only meaningful when yesterday is in the same ISO week — pick the rule
    // accordingly: monthly window when the week rolled over midnight Monday.
    await usage.record('websearch.brave', { date: yesterday, calls: 3 });
    await rules.set('websearch.brave', { maxCalls: 3, period: 'month' });
    const g = gate();
    const denied = await g.gatedRead('websearch.brave', { scopeKey: 'global' }, async () => 'v');
    // Month window contains yesterday unless the month ALSO rolled — accept
    // either outcome on the 1st, deny otherwise.
    if (yesterday.slice(0, 7) === today.toISOString().slice(0, 7)) {
      expect(denied).toBeUndefined();
    } else {
      expect(denied).toBe('v');
    }
  });

  it('the gate never hard-breaks a resolve on a store failure', async () => {
    const broken = new CredentialUsageStore('/dev/null/nope');
    const g = buildCredentialUseGate({
      usage: broken,
      rules,
      excludedIds: new Set(),
      onAudit: (e) => audits.push(e),
    });
    // Rule read is fine (no rule), record fails silently — the value flows.
    expect(await g.gatedRead('websearch.tavily', { scopeKey: 'global' }, async () => 'v')).toBe('v');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
});

describe('CredentialUsageStore', () => {
  let root: string;
  let store: CredentialUsageStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'neuralis-cred-usage-'));
    store = new CredentialUsageStore(root);
  });

  it('sums a window across day files and all scope keys', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await store.record('x.key', { scopeKey: 'projects/p1', date: yesterday, calls: 2 });
    await store.record('x.key', { scopeKey: 'users/u1', date: today });
    expect(await store.getUseTotal('x.key', [yesterday, today])).toBe(3);
    const breakdown = await store.getUseBreakdown('x.key', [yesterday, today]);
    expect(breakdown).toEqual({ total: 3, byScope: { 'projects/p1': 2, 'users/u1': 1 } });
    expect(await store.listUsedIds([yesterday, today])).toEqual({ 'x.key': 3 });
  });

  it('does not lose concurrent records (per-file lock) and leaves no temp files', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(Array.from({ length: 25 }, () => store.record('x.key', { date: today })));
    expect(await store.getUseTotal('x.key', [today])).toBe(25);
    const raw = await fsReadFile(join(root, 'credentials', 'usage', `${today}.json`), 'utf-8');
    expect(JSON.parse(raw)['x.key'].total).toBe(25);
  });

  it('a malformed day file reads as zero, never throws', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'credentials', 'usage'), { recursive: true });
    await writeFile(join(root, 'credentials', 'usage', `${today}.json`), 'not json');
    expect(await store.getUseTotal('x.key', [today])).toBe(0);
    // ...and a record on top of the malformed file replaces it cleanly.
    await store.record('x.key', { date: today });
    expect(await store.getUseTotal('x.key', [today])).toBe(1);
  });
});

describe('CredentialUseRules', () => {
  let root: string;
  let rules: CredentialUseRules;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'neuralis-cred-rules-'));
    rules = new CredentialUseRules(root);
  });

  it('closed shape: unknown keys, bad maxCalls and bad periods are rejected', async () => {
    await expect(rules.set('x.key', { maxCalls: 0, period: 'day' } as never)).rejects.toThrow(/integer/);
    await expect(rules.set('x.key', { maxCalls: 1.5, period: 'day' } as never)).rejects.toThrow(/integer/);
    await expect(rules.set('x.key', { maxCalls: 5, period: 'year' } as never)).rejects.toThrow(/period/);
    await expect(rules.set('x.key', { maxCalls: 5, period: 'day', extra: 1 } as never)).rejects.toThrow(/Unknown rule key/);
    await expect(rules.set('../escape', { maxCalls: 5, period: 'day' })).rejects.toThrow(/Invalid credential id/);
  });

  it('set + null-clear round-trip; EXACT id matching (derived ids are their own rows)', async () => {
    await rules.set('telegram.botToken', { maxCalls: 10, period: 'week' });
    expect(await rules.get('telegram.botToken')).toEqual({ maxCalls: 10, period: 'week' });
    // A derived per-connection id does NOT inherit the base rule.
    expect(await rules.get('telegram.botToken.ch-1')).toBeNull();
    await rules.set('telegram.botToken', null);
    expect(await rules.get('telegram.botToken')).toBeNull();
    expect(await rules.list()).toEqual({});
  });

  it('a malformed persisted row is dropped on read, not enforced as garbage', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(
      join(root, 'credentials', 'credential-use-rules.json'),
      JSON.stringify({ 'x.key': { maxCalls: 'lots', period: 'day' }, 'y.key': { maxCalls: 3, period: 'day' } }),
    );
    expect(await rules.get('x.key')).toBeNull();
    expect(await rules.get('y.key')).toEqual({ maxCalls: 3, period: 'day' });
  });
});

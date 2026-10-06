/**
 * Source-drift pin for the `hostPorts.governance` port's SHAPE.
 *
 * Every member of that port is a gated CALLER ACT: it takes a scalar caller
 * identity and re-derives its own floor from the LIVE project record. That
 * property is what makes the port safe to hand to the admin package through
 * its first-party `ctx.hostPorts`.
 *
 * `pruneAgentOwnership` lives in the same module as `assignAgentToUser` and
 * writes the same map, so it is one careless line away from being added here —
 * and it has NO caller floor by construction (it is the consequence of a gate
 * that already passed, with no caller identity left to check). On the port it
 * would be an unguarded `agentOwnership` write reachable by anything that can
 * reach the port. The pin is the key COUNT plus the names, so a fifth member of
 * any kind has to be argued for rather than slipped in.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8');

function governancePortBody(): string {
  const start = SRC.indexOf('const governance = {');
  expect(start, 'the governance port assignment must exist').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n    };', start);
  expect(end, 'the governance port assignment must terminate').toBeGreaterThan(start);
  expect(SRC).toMatch(/const hostPorts: HostPorts = \{[\s\S]*?\n      governance,\n/);
  const body = SRC.slice(start, end);
  // Non-vacuity: an empty slice would satisfy every assertion below.
  expect(body.length).toBeGreaterThan(40);
  return body;
}

describe('hostPorts.governance port shape', () => {
  it('carries EXACTLY four members, and they are the four gated caller acts', () => {
    const body = governancePortBody();
    const keys = [...body.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(['assignAgent', 'createProject', 'inviteUser', 'patchRoles']);
  });

  it('reaches the admin package through hostPorts only — no globalThis slot', () => {
    expect(SRC).not.toMatch(/__neuralis_(admin_governance|audit_sink)__/);
  });

  it('does NOT publish pruneAgentOwnership — it has no caller floor', () => {
    // Strip comments first: the body deliberately EXPLAINS the exclusion, and
    // a raw substring scan would read that explanation as the violation.
    const code = governancePortBody().replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('pruneAgentOwnership');
  });

  it('the prune is wired as an agent lifecycle hook instead, on both reasons', () => {
    expect(SRC).toContain('agentLifecycle: {');
    expect(SRC).toMatch(/onAgentDeleted:[\s\S]{0,700}reason: 'agent_deleted'/);
    expect(SRC).toMatch(/onAgentCreated:[\s\S]{0,400}reason: 'agent_created'/);
  });

  it('the delete hook also purges the agent\'s own credential directory, BEFORE the prune can fail', () => {
    // A re-created same-slug agent must inherit none of the deleted one's
    // secrets; the purge is keyed on BOTH ids (the scope is project-qualified).
    expect(SRC).toMatch(/onAgentDeleted:[\s\S]{0,300}deleteAgentScope\(projectId, agentId\)[\s\S]{0,400}pruneAgentOwnership/);
  });
});

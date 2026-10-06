/**
 * The setup wizard reads `~/.codex/auth.json` through its OWN copy of the Codex
 * CLI parser (`setup/codexCliAuth.mts`), because a script may import neither
 * `src/**` nor a product package. That copy is a PORT, never a fork: its three
 * functions must stay byte-identical to the provider's, or the wizard imports a
 * login the app would read differently. The bodies are compared, not the files,
 * because the two headers legitimately differ.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PORT_FILE = join(__dirname, '..', 'setup', 'codexCliAuth.mts');
const PROVIDER_FILE = join(
  __dirname, '..', '..', '..',
  'packages', 'agent-core', 'providers', 'openai-codex', 'oauth', 'externalAuth.ts',
);

const FUNCTIONS = [
  'export async function readCodexCliAuth(',
  'function parseJwtPayload(',
  'function readAuthClaims(',
] as const;

/** The declaration through its closing column-0 brace, or a loud failure. */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`no '${signature}' declaration`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`'${signature}' has no closing brace`);
  return source.slice(start, end + 2);
}

function read(file: string): string {
  const text = readFileSync(file, 'utf-8');
  if (text.trim().length === 0) throw new Error(`read an EMPTY source file: ${file}`);
  return text;
}

describe('the wizard\'s Codex CLI parser is a byte-identical port of the provider\'s', () => {
  const port = read(PORT_FILE);
  const provider = read(PROVIDER_FILE);

  it.each(FUNCTIONS)('%s matches', (signature) => {
    const ours = extractFunction(port, signature);
    expect(ours.length).toBeGreaterThan(80);
    expect(ours).toBe(extractFunction(provider, signature));
  });

  it('the comparison can fail — a one-character edit to a body is caught', () => {
    for (const signature of FUNCTIONS) {
      const body = extractFunction(provider, signature);
      const mutated = body.replace('return', 'return /* drift */');
      expect(mutated).not.toBe(body);
      expect(extractFunction(port.replace(extractFunction(port, signature), mutated), signature))
        .not.toBe(body);
    }
  });

  it('the port imports neither src/** nor a product package', () => {
    expect(port).not.toMatch(/from\s+['"](\.\.\/)+src\//);
    expect(port).not.toMatch(/['"]@neuralis\/(agent-core|brain-core|machine-core|admin)/);
  });
});

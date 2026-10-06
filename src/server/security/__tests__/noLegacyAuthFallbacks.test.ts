import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'CommunityHttpAuthService',
  'MCP_DEFAULT_USER_ID',
  'MCP_DEFAULT_PROJECT_ID',
  'MCP_DEFAULT_AGENT_ID',
  "'local-user'",
  "'default-project'",
  "'local-agent'",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
      out.push(...walk(path));
    } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
      out.push(path);
    }
  }
  return out;
}

describe('legacy auth fallbacks', () => {
  it('keeps removed MCP default identity fallbacks out of active source', () => {
    const root = join(process.cwd(), 'src');
    const hits: string[] = [];

    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf-8');
      for (const forbidden of FORBIDDEN) {
        if (text.includes(forbidden)) hits.push(`${file}: ${forbidden}`);
      }
    }

    expect(hits).toEqual([]);
  });
});

/**
 * The Admin environment rows say what the running host does with each value —
 * never a second default of their own, and never a knob nothing reads.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENV_INFO } from '../env';

afterEach(() => {
  vi.unstubAllEnvs();
});

const row = (name: string) => ENV_INFO.find((r) => r.name === name);

describe('ENV_INFO', () => {
  it('BRAIN_INFRA_MODE unset reads as the default brain-core applies (in-memory), and a set value as itself', () => {
    vi.stubEnv('BRAIN_INFRA_MODE', '');
    expect(row('BRAIN_INFRA_MODE')?.value()).toBe('inmemory');
    vi.stubEnv('BRAIN_INFRA_MODE', 'local');
    expect(row('BRAIN_INFRA_MODE')?.value()).toBe('local');
    // derive-and-verify: the brain-core reader's own default.
    const wiring = readFileSync(fileURLToPath(new URL('../../../../../packages/brain-core/src/wiring.ts', import.meta.url)), 'utf8');
    expect(wiring).toContain("String(env.BRAIN_INFRA_MODE ?? 'inmemory')");
  });

  it.each(['NEXTAUTH_URL', 'APP_URL', 'MCP_BASE_URL'])('%s unset reads as unset — never a port-blind origin the host would not answer on', (name) => {
    vi.stubEnv('NEURALIS_APP_PORT', '3104');
    vi.stubEnv('MCP_HTTP_PORT', '3105');
    vi.stubEnv(name, '');
    expect(row(name)?.value()).toBe('(unset)');
    // RED CONTROL: no origin row may answer a localhost default of its own.
    expect(row(name)?.value()).not.toMatch(/^http:\/\/localhost:/);
    vi.stubEnv(name, 'https://neuralis.corp');
    expect(row(name)?.value()).toBe('https://neuralis.corp');
  });

  it('lists no variable nothing reads (NEURALIS_ADMIN_EMAIL is gone)', () => {
    expect(row('NEURALIS_ADMIN_EMAIL')).toBeUndefined();
  });
});

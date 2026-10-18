/**
 * `scripts/host-broker/helper.mts` — the shared ops parsers (the compose
 * project an install records, the digest the rebuild's helper-drift line
 * compares). The install / upgrade / grant decisions of the retired host-broker
 * verb live in the device client now (`packages/cli/test/device.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeProjectFromEnv, parseSha256sum, sha256File } from '../host-broker/helper.mts';

describe('small parsers', () => {
  it('compose project comes from .env, default otherwise', () => {
    expect(composeProjectFromEnv('NEURALIS_COMPOSE_PROJECT=neuralis-test\nOTHER=1\n')).toBe('neuralis-test');
    expect(composeProjectFromEnv('OTHER=1\n')).toBe('neuralis');
    expect(composeProjectFromEnv(null)).toBe('neuralis');
  });
  it('sha256sum output and file digest agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrs-helper-'));
    try {
      const f = join(dir, 'bin');
      writeFileSync(f, 'abc');
      const hex = sha256File(f);
      expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(parseSha256sum(`${hex}  /usr/local/bin/nrs-sandboxer\n`)).toBe(hex);
      expect(parseSha256sum('sha256sum: no such file\n')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

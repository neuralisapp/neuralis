import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { BUILD_VALIDATE_RECORD, admitBuiltins, optionalBuiltinIds, readBuildRefusals, readDisabledBuiltins } from '../buildRefusals';
import { HOST_CONFIG_SETTINGS } from '../../config/hostConfigSettings';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function hostRoot(record?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'neuralis-build-record-'));
  roots.push(root);
  if (record !== undefined) {
    mkdirSync(dirname(join(root, BUILD_VALIDATE_RECORD)), { recursive: true });
    writeFileSync(join(root, BUILD_VALIDATE_RECORD), record);
  }
  return root;
}

const def = (id: string, keys: string[] = []): PackageDefinition => ({
  id, name: id, source: { kind: 'neuralis' }, access: { trust: 'native' },
  ...(keys.length > 0 ? { configSettings: keys.map((key) => ({ key, type: 'string', default: '', description: key })) } : {}),
} as PackageDefinition);
const noOwner = (): undefined => undefined;

describe('the build admission record', () => {
  it('no record (a dev tree) admits every builtin', async () => {
    expect(await readBuildRefusals(hostRoot())).toEqual({ kind: 'none' });
  });

  it('maps the closed build reasons onto the runtime refusal codes, never the error text', async () => {
    const root = hostRoot(JSON.stringify({ checked: 3, failed: [], refused: [
      { packageId: '@acme/bad', reason: 'invalid', errors: ['tools/ping.json: category is required'] },
      { packageId: '@acme/dup', reason: 'conflict', errors: ['contract "agent-directory" is provided by both …'] },
    ] }));
    expect(await readBuildRefusals(root)).toEqual({ kind: 'record', refused: [
      { packageId: '@acme/bad', reason: 'load_failed' },
      { packageId: '@acme/dup', reason: 'conflict' },
    ] });
  });

  it.each([
    ['not JSON', '{'],
    ['no refused list', '{"checked":1}'],
    ['an unknown reason', '{"refused":[{"packageId":"@acme/x","reason":"maybe","errors":[]}]}'],
    ['an empty id', '{"refused":[{"packageId":"","reason":"invalid","errors":[]}]}'],
  ])('%s is malformed — the boot logs it and admits every builtin', async (_label, text) => {
    expect(await readBuildRefusals(hostRoot(text))).toEqual({ kind: 'malformed' });
  });

  it('admitBuiltins leaves the refused ids out, keeps the host order, drops a record entry for a removed dependency', () => {
    const { admitted, refused } = admitBuiltins(
      [def('@neuralis/agent-core'), def('@acme/dup'), def('@neuralis/admin')],
      [{ packageId: '@acme/dup', reason: 'conflict' }, { packageId: '@acme/gone', reason: 'load_failed' }],
      noOwner,
    );
    expect(admitted.map((d) => d.id)).toEqual(['@neuralis/agent-core', '@neuralis/admin']);
    expect(refused).toEqual([{ packageId: '@acme/dup', reason: 'conflict' }]);
  });

  it('control: an empty record admits everything', () => {
    const all = [def('@neuralis/agent-core'), def('@acme/x')];
    expect(admitBuiltins(all, [], noOwner)).toEqual({ admitted: all, refused: [], keyCollisions: [] });
  });

  it('a package declaring a key the HOST owns is refused as conflict, both sides and the key named — the boot goes on', () => {
    const hostKeys = new Map([['logLevel', 'host'], ['maxProjects', 'host']]);
    const { admitted, refused, keyCollisions } = admitBuiltins(
      [def('@neuralis/agent-core', ['maxAgentSteps']), def('@acme/loud', ['logLevel', 'acmeMode'])],
      [],
      (key) => hostKeys.get(key),
    );
    expect(admitted.map((d) => d.id)).toEqual(['@neuralis/agent-core']);
    expect(refused).toEqual([{ packageId: '@acme/loud', reason: 'conflict' }]);
    expect(keyCollisions).toEqual([{ packageId: '@acme/loud', key: 'logLevel', declaredBy: 'host' }]);
  });

  it('control: a key already registered by a package OF the set (a dev re-boot) or by itself is no collision', () => {
    const owners = new Map([['maxAgentSteps', '@neuralis/agent-core'], ['acmeMode', '@acme/x']]);
    const all = [def('@neuralis/agent-core', ['maxAgentSteps']), def('@acme/x', ['acmeMode'])];
    expect(admitBuiltins(all, [], (key) => owners.get(key))).toEqual({ admitted: all, refused: [], keyCollisions: [] });
  });

  it('a build-refused package is never judged again against the host keys', () => {
    const { refused, keyCollisions } = admitBuiltins(
      [def('@acme/loud', ['logLevel'])],
      [{ packageId: '@acme/loud', reason: 'load_failed' }],
      () => 'host',
    );
    expect(refused).toEqual([{ packageId: '@acme/loud', reason: 'load_failed' }]);
    expect(keyCollisions).toEqual([]);
  });
});

describe('the operator\'s turned-off builtins (disabledBuiltinPackages)', () => {
  it('the host reader takes ONLY a builtin whose manifest declares itself optional; every other id is named and ignored, a non-list turns nothing off', () => {
    const optional = optionalBuiltinIds([def('@neuralis/agent-core'), { ...def('@neuralis/machine-core'), optional: true }, { ...def('@acme/x'), optional: 'true' as unknown as boolean }]);
    expect(optional).toEqual(new Set(['@neuralis/machine-core']));
    expect(readDisabledBuiltins(['@neuralis/machine-core'], optional)).toEqual({ disabled: new Set(['@neuralis/machine-core']), ignored: [], malformed: false });
    expect(readDisabledBuiltins(['@neuralis/agent-core', '@neuralis/machine-core', '@acme/x'], optional)).toEqual({
      disabled: new Set(['@neuralis/machine-core']), ignored: ['@neuralis/agent-core', '@acme/x'], malformed: false,
    });
    // No declaration, no turning off: the host names no package itself.
    expect(readDisabledBuiltins(['@neuralis/machine-core'], new Set())).toEqual({ disabled: new Set(), ignored: ['@neuralis/machine-core'], malformed: false });
    for (const value of [undefined, null, '', []]) expect(readDisabledBuiltins(value, optional)).toEqual({ disabled: new Set(), ignored: [], malformed: false });
    for (const value of ['@neuralis/machine-core', { '@neuralis/machine-core': true }, [1]]) expect(readDisabledBuiltins(value, optional)).toMatchObject({ disabled: new Set(), malformed: true });
  });

  it('the shipped virtual desktop declares itself optional, and no other native package does', () => {
    const manifests = ['admin', 'agent-core', 'brain-core', 'machine-core'].map((slug) =>
      JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'packages', slug, 'package.json'), 'utf8')) as { name: string; neuralis: Record<string, unknown> });
    expect(manifests.filter((m) => m.neuralis.optional === true).map((m) => m.name)).toEqual(['@neuralis/machine-core']);
  });

  it('a turned-off builtin is left out as `disabled` before any other judgement; the rest are admitted in order', () => {
    const { admitted, refused } = admitBuiltins(
      [def('@neuralis/agent-core'), def('@neuralis/machine-core', ['machineImage']), def('@neuralis/admin')],
      [{ packageId: '@neuralis/machine-core', reason: 'load_failed' }],
      noOwner,
      new Set(['@neuralis/machine-core']),
    );
    expect(admitted.map((m) => m.id)).toEqual(['@neuralis/agent-core', '@neuralis/admin']);
    expect(refused).toEqual([{ packageId: '@neuralis/machine-core', reason: 'disabled' }]);
  });

  it('the key is a host-declared json setting whose default turns nothing off', () => {
    expect(HOST_CONFIG_SETTINGS.find((s) => s.key === 'disabledBuiltinPackages')).toMatchObject({ type: 'json', default: [] });
  });
});

describe('a package from the runtime install record (no build record judges it)', () => {
  const provides = (id: string, contract: string): PackageDefinition => ({ ...def(id), provides: [contract] } as PackageDefinition);

  it('in conflict with an image builtin over a config key or a contract it is refused ALONE as `conflict`; the image package keeps it', () => {
    const { admitted, refused } = admitBuiltins(
      [def('@neuralis/agent-core', ['toolResultContentCapChars']), def('@acme/late', ['toolResultContentCapChars']), provides('@neuralis/brain-core', 'package-source-roots'), provides('@acme/late2', 'package-source-roots')],
      [],
      noOwner,
      new Set(),
      new Set(['@acme/late', '@acme/late2']),
    );
    expect(admitted.map((m) => m.id)).toEqual(['@neuralis/agent-core', '@neuralis/brain-core']);
    expect([...refused].sort((a, b) => a.packageId.localeCompare(b.packageId))).toEqual([{ packageId: '@acme/late', reason: 'conflict' }, { packageId: '@acme/late2', reason: 'conflict' }]);
  });

  it('the same pair with NEITHER side from the record is left to the build record (nothing refused here)', () => {
    const { admitted, refused } = admitBuiltins([def('@neuralis/agent-core', ['k']), def('@acme/late', ['k'])], [], noOwner);
    expect(admitted).toHaveLength(2);
    expect(refused).toEqual([]);
  });
});

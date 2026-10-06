import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { compileUnionSheetOffThread } from '@neuralis/package-system/runtime/ui-sheet';
import { getUiAttachments } from '../packageUiModules';

const state = vi.hoisted(() => ({ definitions: [] as PackageDefinition[] }));
vi.mock('../runtime', () => ({ getCommunityPackageRegistry: () => ({ listPackages: () => state.definitions }) }));
vi.mock('../../host/builtinSlots', async (original) => {
  const actual = await original<typeof import('../../host/builtinSlots')>();
  return { ...actual, BUILTIN_PACKAGE_IDS: new Set(['@acme/cache']), resolveBuiltinRoot: () => '/missing/package' };
});
vi.mock('../../logging/setup', () => ({ getLogger: () => ({ child: () => ({ info: vi.fn(), warn: vi.fn() }) }) }));
vi.mock('@neuralis/package-system/runtime/ui-sheet', async (original) => ({
  ...await original<typeof import('@neuralis/package-system/runtime/ui-sheet')>(), compileUnionSheetOffThread: vi.fn(),
}));

const sheet = {
  css: '.p-2{}', hash: 'a'.repeat(64), bytes: 6, candidates: 1, files: 1,
  timings: { compileMs: 1, scanMs: 1, buildMs: 1, totalMs: 3 },
  worker: { engineLoadMs: 1, wallMs: 5, inputBytes: 100, outputBytes: 200, sourceCount: 1,
    compileStartedAt: 1, compileEndedAt: 4 },
};
function definition(): PackageDefinition {
  return { id: '@acme/cache', name: 'cache', version: '1.0.0', access: { trust: 'first-party' } } as PackageDefinition;
}
beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('neuralis.packageUi.attachments'));
  state.definitions = [definition()];
  vi.mocked(compileUnionSheetOffThread).mockReset().mockResolvedValue(sheet);
});

describe('definition-set attachment promise', () => {
  it('shares concurrent prewarm/request callers and ignores a project-only registry change', async () => {
    const [prewarm, request] = await Promise.all([getUiAttachments(), getUiAttachments()]);
    expect(request).toBe(prewarm);
    expect(compileUnionSheetOffThread).toHaveBeenCalledTimes(1);
    state.definitions.push({ ...definition(), id: 'project-package', access: { trust: 'untrusted' } });
    expect(await getUiAttachments()).toBe(prewarm);
    expect(compileUnionSheetOffThread).toHaveBeenCalledTimes(1);
    state.definitions[0] = definition();
    expect(await getUiAttachments()).not.toBe(prewarm);
    expect(compileUnionSheetOffThread).toHaveBeenCalledTimes(2);
  });

  it('names a worker failure without pinning arbitrary source paths in the sheet error', async () => {
    vi.mocked(compileUnionSheetOffThread).mockRejectedValue(new Error('/private/source/path'));
    const built = await getUiAttachments();
    expect(built.sheet).toBeNull();
    expect(built.sheetError).toBe('UnionSheetCompileFailed');
  });
});

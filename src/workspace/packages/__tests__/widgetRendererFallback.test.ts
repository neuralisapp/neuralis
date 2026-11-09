/**
 * The text a `direct` widget shows while its package module is not registered.
 *
 * Pinned: "Loading…" before the host's first `ui` view (it is still booting or
 * restarting), while the module imports, and after an import that rejected (the
 * next view retries it); "cannot be rendered" only once a view lists no module
 * for the package; a module the host refused names its reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { UiModuleDescriptor, WidgetRuntimeDefinition } from '@neuralis/package-system/contracts';
import { UI_MODULE_HOST_API_VERSION } from '@neuralis/package-system/client/shared-modules';
import { ensureUiModules } from '../uiModuleLoader';
import { resolveWidgetRenderer } from '../WidgetRendererStrategy';

const g = globalThis as Record<PropertyKey, unknown>;
const STATE = Symbol.for('neuralis.workspace.uiModuleLoader');
const hash = 'd'.repeat(64);
const module: UiModuleDescriptor = { packageId: '@acme/apps', hash, entryUrl: `/api/package-ui/${hash}/host.js`, sharedImports: ['react'], hostApiVersion: UI_MODULE_HOST_API_VERSION, reactMajor: 19 };
const widget = {
  kind: 'widget', type: 'acme-apps', title: 'Apps', packageId: '@acme/apps',
  component: { renderer: 'direct', import: '@acme/apps#AppsWidget' },
} as unknown as WidgetRuntimeDefinition;

const text = (): string => {
  const definition = resolveWidgetRenderer(widget, 'native');
  const instance = { id: 'w1', type: 'acme-apps', agentId: 'a1' };
  return renderToStaticMarkup(definition.render({ agentId: 'a1', instance } as never) as ReactElement);
};

beforeEach(() => { delete g[STATE]; g.window = globalThis; vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { delete g[STATE]; delete g.window; vi.restoreAllMocks(); });

describe('a direct widget without its module', () => {
  it('reads "Loading…" before the host\'s first ui view', () => {
    expect(text()).toContain('Loading…');
  });

  it('reads "Loading…" after its import rejected — the next view imports it again', async () => {
    await ensureUiModules({ modules: [module], sheet: null, refused: [] }, async () => { throw new TypeError('Failed to fetch dynamically imported module'); });
    expect(text()).toContain('Loading…');
    expect(text()).not.toContain('cannot be rendered');
  });

  it('says it cannot be rendered once a view lists no module for its package; a refusal names its reason', async () => {
    await ensureUiModules({ modules: [], sheet: null, refused: [] });
    expect(text()).toContain('This widget cannot be rendered by this host.');
    await ensureUiModules({ modules: [], sheet: null, refused: [{ packageId: '@acme/apps', reason: 'react-major' }] });
    expect(text()).toContain('Its UI module was refused (react-major)');
  });
});

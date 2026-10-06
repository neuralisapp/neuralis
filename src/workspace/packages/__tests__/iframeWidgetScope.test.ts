/**
 * IframeWidget asset-scope churn (CARD1 3A regression fix, 2026-07-27).
 *
 * The mint effect must key on the PRIMITIVE scope coordinate, never on the
 * `source` OBJECT. `resolveWidgetRenderer` builds a fresh `source` literal on
 * every call and the runtime hub re-hydrates the widget registry on every
 * CONNECT (`api/events/route.ts` sends `runtime:snapshot` when the stream
 * opens, not only on a real change), so an identity dependency made every hub
 * reconnect release the scope (refCount 0 → `DELETE`), re-mint a fresh random
 * handle (`POST`) and navigate the frame to a new URL — a full reload of every
 * asset-backed widget. Before 3A the dep was the `src` STRING and a re-hydrate
 * caused ZERO churn; these tests pin that property back.
 *
 * The host suite has no DOM (`neuralis/vitest.config.mts` → `environment:
 * 'node'`, `*.test.ts` only), so the component is driven through the exact body
 * it calls (`runIframeWidgetScopeEffect`) with the exact dependency values it
 * passes (`iframeWidgetScopeDeps`), replayed by a minimal, faithful model of
 * React's `useEffect` dep rule (Object.is per index, cleanup BEFORE the re-run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetScopeCoordinate } from '../packageAssetScope';
import { EXTERNAL_FRAME_SANDBOX, OPAQUE_FRAME_SANDBOX } from '@neuralis/package-system/client';
import {
  iframeWidgetSandbox,
  iframeWidgetScopeDeps,
  runIframeWidgetScopeEffect,
  type IframeWidgetAssetCoordinate,
  type IframeWidgetScopeDeps,
  type IframeWidgetSource,
} from '../IframeWidget';

const mocks = vi.hoisted(() => {
  const acquires: AssetScopeCoordinate[] = [];
  const releases: string[] = [];
  const revokers: Array<() => void> = [];
  let mintCounter = 0;
  return {
    acquires,
    releases,
    revokers,
    reset: () => {
      acquires.length = 0;
      releases.length = 0;
      revokers.length = 0;
      mintCounter = 0;
    },
    /**
     * Mirrors the real client's contract: a FRESH random handle (and therefore
     * a new URL) on every mint — exactly why an identity-keyed effect reloads
     * the frame.
     */
    acquirePackageAssetScope: vi.fn(async (coord: AssetScopeCoordinate) => {
      mintCounter += 1;
      const url = `/api/package-app/_scope/handle-${mintCounter}/surface/index.html`;
      acquires.push(coord);
      let released = false;
      return {
        url,
        release: () => {
          if (released) return;
          released = true;
          releases.push(url);
        },
        onRevoked: (cb: () => void) => {
          revokers.push(cb);
          return () => {
            const at = revokers.indexOf(cb);
            if (at >= 0) revokers.splice(at, 1);
          };
        },
      };
    }),
  };
});

// Only the network-touching mint is stubbed; the shared url classifier stays real.
vi.mock('../packageAssetScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packageAssetScope')>()),
  acquirePackageAssetScope: mocks.acquirePackageAssetScope,
}));

// The component module imports the workspace session hook at module scope; the
// store is not under test here (and its `persist` wrapper needs a browser).
vi.mock('../../store/selectors', () => ({
  useWorkspaceSession: () => ({ projectId: null, agentId: null }),
}));

/** Exactly React's `useEffect(fn, deps)` rule, and nothing else. */
class EffectHarness {
  private deps: readonly unknown[] | null = null;
  private cleanup: (() => void) | null = null;

  commit(deps: readonly unknown[], effect: () => () => void): void {
    const prev = this.deps;
    if (prev && prev.length === deps.length && prev.every((d, i) => Object.is(d, deps[i]))) return;
    this.cleanup?.();
    this.deps = deps;
    this.cleanup = effect();
  }

  unmount(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.deps = null;
  }
}

/** Drain the mint promise chain. */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const COORDINATE: IframeWidgetAssetCoordinate = {
  packageId: 'p.proj-1.project.probe',
  surfaceId: 'probe_workspace',
  fingerprint: 'widget:./app/surfaces/widget/probe_workspace/index.html',
};

/** A structurally identical source with a BRAND NEW object identity. */
function scopedSource(
  overrides: Partial<IframeWidgetAssetCoordinate> = {},
): IframeWidgetSource {
  return { kind: 'scoped-asset', coordinate: { ...COORDINATE, ...overrides } };
}

function depTuple(deps: IframeWidgetScopeDeps): readonly unknown[] {
  return [deps.kind, deps.absoluteUrl, deps.packageId, deps.surfaceId, deps.fingerprint];
}

/**
 * Mounts the widget's effect and lets a test re-render it, mirroring
 * `IframeWidget`: the dependency list is built from `iframeWidgetScopeDeps`
 * plus the session halves and the revocation `generation`.
 */
function mountWidget(source: IframeWidgetSource, session: { projectId?: string | null; agentId?: string | null } = {}) {
  const harness = new EffectHarness();
  const state = {
    source,
    src: null as string | null,
    generation: 0,
    projectId: session.projectId === undefined ? 'proj-1' : session.projectId,
    agentId: session.agentId === undefined ? 'agent-1' : session.agentId,
  };

  const commit = (): void => {
    const deps = iframeWidgetScopeDeps(state.source);
    harness.commit(
      [...depTuple(deps), state.projectId, state.agentId, state.generation],
      () => runIframeWidgetScopeEffect({
        ...deps,
        projectId: state.projectId,
        agentId: state.agentId,
        setSrc: (next) => { state.src = next; },
        onRevoked: () => { state.generation += 1; commit(); },
      }),
    );
  };

  commit();
  return {
    state,
    /** One re-render — what React does on every registry re-hydrate. */
    render(next: Partial<Pick<typeof state, 'source' | 'projectId' | 'agentId'>> = {}): void {
      if (next.source !== undefined) state.source = next.source;
      if (next.projectId !== undefined) state.projectId = next.projectId;
      if (next.agentId !== undefined) state.agentId = next.agentId;
      commit();
    },
    unmount: () => harness.unmount(),
  };
}

beforeEach(() => {
  mocks.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('iframeWidgetScopeDeps — the primitive projection', () => {
  it('drops object identity: two identical sources project EQUAL primitives', () => {
    expect(depTuple(iframeWidgetScopeDeps(scopedSource())))
      .toEqual(depTuple(iframeWidgetScopeDeps(scopedSource())));
    // …and they are genuinely different objects (the churn precondition).
    expect(scopedSource()).not.toBe(scopedSource());
  });

  it('EVERY coordinate field moves a dependency (drift guard)', () => {
    const base = depTuple(iframeWidgetScopeDeps(scopedSource()));
    const keys = Object.keys(COORDINATE) as (keyof IframeWidgetAssetCoordinate)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const moved = depTuple(iframeWidgetScopeDeps(scopedSource({ [key]: `${COORDINATE[key]}-moved` })));
      // A field that reaches the mint but not the dep list = the 3A regression
      // in a new shape: a real manifest change would stop re-minting.
      expect(moved, `coordinate field "${key}" is not a dependency`).not.toEqual(base);
    }
  });

  it('an absolute url is its own dependency and never mints', async () => {
    const widget = mountWidget({ kind: 'absolute', url: 'https://example.test/a.html' });
    await flush();
    expect(widget.state.src).toBe('https://example.test/a.html');
    expect(mocks.acquires).toHaveLength(0);

    // A fresh literal with the same url: no churn, byte-identical src.
    widget.render({ source: { kind: 'absolute', url: 'https://example.test/a.html' } });
    await flush();
    expect(widget.state.src).toBe('https://example.test/a.html');

    widget.render({ source: { kind: 'absolute', url: 'https://example.test/b.html' } });
    await flush();
    expect(widget.state.src).toBe('https://example.test/b.html');
    expect(mocks.acquires).toHaveLength(0);
  });
});

describe('IframeWidget scope effect — registry re-hydrate (the regression)', () => {
  it('(a) a NEW source object with identical content: 0 release, 0 re-acquire, unchanged src', async () => {
    const widget = mountWidget(scopedSource());
    await flush();
    expect(mocks.acquires).toHaveLength(1);
    const mintedSrc = widget.state.src;
    expect(mintedSrc).toBe('/api/package-app/_scope/handle-1/surface/index.html');

    // Three hub-driven re-hydrates, each handing down a brand new literal.
    widget.render({ source: scopedSource() });
    widget.render({ source: scopedSource() });
    widget.render({ source: scopedSource() });
    await flush();

    expect(mocks.acquires).toHaveLength(1);
    expect(mocks.releases).toHaveLength(0);
    // Byte-identical → React keeps the same `src` attribute → no navigation.
    expect(widget.state.src).toBe(mintedSrc);

    widget.unmount();
    expect(mocks.releases).toHaveLength(1);
  });

  it('(b) a MOVED fingerprint re-mints exactly once and navigates', async () => {
    const widget = mountWidget(scopedSource());
    await flush();
    const firstSrc = widget.state.src;

    widget.render({ source: scopedSource({ fingerprint: 'widget:./app/surfaces/widget/probe_workspace/v2.html' }) });
    await flush();

    expect(mocks.releases).toHaveLength(1);
    expect(mocks.acquires).toHaveLength(2);
    expect(mocks.acquires[1]?.fingerprint).toBe('widget:./app/surfaces/widget/probe_workspace/v2.html');
    expect(widget.state.src).not.toBe(firstSrc);
    expect(widget.state.src).toBe('/api/package-app/_scope/handle-2/surface/index.html');
  });

  it('(b) a moved packageId / surfaceId re-mints on the new coordinate too', async () => {
    const widget = mountWidget(scopedSource());
    await flush();

    widget.render({ source: scopedSource({ surfaceId: 'other_workspace' }) });
    await flush();
    expect(mocks.acquires).toHaveLength(2);
    expect(mocks.acquires[1]).toMatchObject({ surfaceKind: 'widget', surfaceId: 'other_workspace' });

    widget.render({ source: scopedSource({ surfaceId: 'other_workspace', packageId: 'p.proj-1.project.other' }) });
    await flush();
    expect(mocks.acquires).toHaveLength(3);
    expect(mocks.acquires[2]).toMatchObject({ packageId: 'p.proj-1.project.other' });
    expect(mocks.releases).toHaveLength(2);
  });

  it('the mint carries the full coordinate (session halves included)', async () => {
    mountWidget(scopedSource());
    await flush();
    expect(mocks.acquires[0]).toEqual({
      projectId: 'proj-1',
      agentId: 'agent-1',
      packageId: COORDINATE.packageId,
      surfaceKind: 'widget',
      surfaceId: COORDINATE.surfaceId,
      fingerprint: COORDINATE.fingerprint,
    });
  });
});

describe('IframeWidget scope effect — unchanged generation / session semantics (c)', () => {
  it('a revocation bumps the generation: release + fresh mint + new src', async () => {
    const widget = mountWidget(scopedSource());
    await flush();
    const firstSrc = widget.state.src;
    expect(mocks.revokers).toHaveLength(1);

    // Heartbeat 403/410 — the server revoked this document generation.
    mocks.revokers[0]!();
    await flush();

    expect(widget.state.generation).toBe(1);
    expect(mocks.releases).toHaveLength(1);
    expect(mocks.acquires).toHaveLength(2);
    expect(widget.state.src).not.toBe(firstSrc);
  });

  it('a project switch releases and re-mints on the new project', async () => {
    const widget = mountWidget(scopedSource());
    await flush();

    widget.render({ projectId: 'proj-2' });
    await flush();
    expect(mocks.releases).toHaveLength(1);
    expect(mocks.acquires[1]).toMatchObject({ projectId: 'proj-2' });

    // An agent switch is its own dependency as well.
    widget.render({ agentId: 'agent-2' });
    await flush();
    expect(mocks.releases).toHaveLength(2);
    expect(mocks.acquires[2]).toMatchObject({ projectId: 'proj-2', agentId: 'agent-2' });
  });

  it('no project = no mint (fail closed), and the mint starts once one arrives', async () => {
    const widget = mountWidget(scopedSource(), { projectId: null });
    await flush();
    expect(mocks.acquires).toHaveLength(0);
    expect(widget.state.src).toBeNull();

    widget.render({ projectId: 'proj-1' });
    await flush();
    expect(mocks.acquires).toHaveLength(1);
    expect(widget.state.src).toBe('/api/package-app/_scope/handle-1/surface/index.html');
  });

  it('an unmount mid-mint releases the scope that lands late', async () => {
    const widget = mountWidget(scopedSource());
    widget.unmount(); // before the mint promise resolves
    await flush();
    expect(mocks.acquires).toHaveLength(1);
    expect(mocks.releases).toHaveLength(1);
    expect(widget.state.src).toBeNull();
  });
});

describe('iframeWidgetSandbox — the kernel external-frame profile on the widget', () => {
  const HOST = 'https://neuralis.example';

  it('gives a first-party https app on a foreign origin its own origin (the paired positive)', () => {
    expect(iframeWidgetSandbox({ kind: 'absolute', url: 'https://app.company.example/', trust: 'first-party' }, HOST)).toBe(
      EXTERNAL_FRAME_SANDBOX,
    );
    expect(EXTERNAL_FRAME_SANDBOX).not.toMatch(/allow-top-navigation/);
  });

  it('keeps the opaque sandbox for every other source', () => {
    const opaque = [
      iframeWidgetSandbox({ kind: 'absolute', url: 'https://app.company.example/', trust: 'trusted' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: 'https://app.company.example/' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: '/api/x', trust: 'first-party' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: '//app.company.example/', trust: 'first-party' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: `${HOST}/x`, trust: 'first-party' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: 'http://app.company.example/', trust: 'first-party' }, HOST),
      iframeWidgetSandbox({ kind: 'absolute', url: 'https://app.company.example/', trust: 'first-party' }, null),
      iframeWidgetSandbox({ kind: 'scoped-asset', coordinate: { packageId: 'p', surfaceId: 's', fingerprint: 'f' } }, HOST),
    ];
    expect(new Set(opaque)).toEqual(new Set([OPAQUE_FRAME_SANDBOX]));
  });
});

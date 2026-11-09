import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeNode } from './fakeDom';

const dom = installFakeDom();
// The canvas surface the sky draws on, and a WebGL probe that names no renderer (a GPU: the loop runs).
const page = { hidden: false, focused: true, frames: 0, paints: 0 };
const make = dom.document.createElement as (name: string) => FakeNode;
Object.assign(dom.document, {
  createElement: (name: string) => {
    const node = make(name);
    if (name.toLowerCase() === 'canvas') {
      node.getContext = (kind: string) => kind === 'webgl'
        ? { getExtension: () => null }
        : { setTransform() {}, clearRect() { page.paints += 1; }, beginPath() {}, arc() {}, fill() {}, fillStyle: '', globalAlpha: 1 };
    }
    return node;
  },
  hasFocus: () => page.focused,
});
Object.defineProperty(dom.document, 'hidden', { get: () => page.hidden, configurable: true });
dom.document.documentElement = Object.assign(dom.document.documentElement as FakeNode, { toggleAttribute() {} });
Object.assign(window, { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
let nextFrame = 1;
const scheduled = new Map<number, (time: number) => void>();
vi.stubGlobal('requestAnimationFrame', (fn: (time: number) => void) => { page.frames += 1; scheduled.set(nextFrame, fn); return nextFrame++; });
vi.stubGlobal('cancelAnimationFrame', (handle: number) => { scheduled.delete(handle); });

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AnimatedUniverseBackground, NO_WEBGL_CONTEXT, softwareCompositedRenderer } = await import('../AnimatedUniverseBackground');

describe('softwareCompositedRenderer — the star field holds still where every frame is re-blurred on the CPU', () => {
  it('names the GPU-less renderers a browser reports', () => {
    for (const r of [
      'ANGLE (Mesa, llvmpipe (LLVM 19.1.1, 256 bits), OpenGL 4.5)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)',
    ]) expect(softwareCompositedRenderer(r)).toBe(true);
  });

  it('no WebGL context at all is a software compositor too', () => {
    expect(softwareCompositedRenderer(NO_WEBGL_CONTEXT)).toBe(true);
  });

  it('a real GPU, and a context that hides its renderer name, keep the animation', () => {
    expect(softwareCompositedRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)')).toBe(false);
    expect(softwareCompositedRenderer('Apple M3')).toBe(false);
    expect(softwareCompositedRenderer(null)).toBe(false);
  });
});

describe('the animated sky runs only while the window has focus — from the mount on', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    scheduled.clear();
    Object.assign(page, { hidden: false, focused: true, frames: 0, paints: 0 });
  });
  const mount = async (): Promise<void> => {
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(AnimatedUniverseBackground)));
  };

  it('mounted in an unfocused window: one frame painted, no frame scheduled; focus starts the loop', async () => {
    page.focused = false;
    await mount();
    expect(page.paints).toBe(1);
    expect(scheduled.size).toBe(0);
    page.focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(scheduled.size).toBe(1);
  });

  it('mounted in a hidden tab: the same — nothing scheduled until it is visible', async () => {
    page.hidden = true;
    await mount();
    expect(scheduled.size).toBe(0);
  });

  it('CONTROL — mounted focused and visible: the loop is scheduled at once (the designed animation)', async () => {
    await mount();
    expect(scheduled.size).toBe(1);
  });
});

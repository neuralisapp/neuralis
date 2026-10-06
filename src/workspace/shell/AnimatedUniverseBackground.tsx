'use client';

import { useEffect, useRef, useState } from 'react';
import { createFrameLoop } from './frameLoop';

type Node = {
  x: number;
  y: number;
  z: number;
  speed: number;
  size: number;
  baseAlpha: number;
  age: number;       // frames alive (for fade-in)
};

/** `reduce` users get exactly one static frame; everyone else gets the loop. */
type Motion = 'static' | 'animate';

const NODE_COUNT = 100;
const DEPTH = 1200;
const FOCAL_LENGTH = 320;
const FADE_IN_FRAMES = 60; // ~1 second fade-in at 60fps
const MAX_DT = 2.0;

/**
 * Frames of headless advance used to warm a fresh pool to steady state before
 * the single static frame. `initNode` seeds `x,y` in ±0.9·(w,h) with `z`
 * uniform in (0, DEPTH], and the projection `sx = cx + x·(FOCAL_LENGTH/z)` puts
 * a node on-screen only when |x| < w·z/640 — so ~40-45 % of a fresh pool
 * projects OFF-screen and is culled on frame 1. The animated loop self-corrects
 * within seconds (culled nodes respawn at `z = DEPTH`, where the 0.267 scale
 * puts every |x| ≤ 0.9w inside the viewport); a single frame over a fresh pool
 * would show a visibly sparser sky than the animation it replaces. ~20k
 * arithmetic iterations, sub-millisecond, once per mount/resize.
 */
const STATIC_WARMUP_FRAMES = 200;

function initNode(node: Node, width: number, height: number, farSpawn: boolean) {
  node.x = (Math.random() * 2 - 1) * width * 0.9;
  node.y = (Math.random() * 2 - 1) * height * 0.9;
  node.z = farSpawn ? DEPTH : Math.random() * DEPTH + 1;
  node.speed = 0.22 + Math.random() * 0.36;
  node.size = 0.6 + Math.random() * 1.3;
  node.baseAlpha = 0.25 + Math.random() * 0.45;
  node.age = farSpawn ? 0 : FADE_IN_FRAMES; // existing nodes start fully visible
}

function createNodePool(width: number, height: number): Node[] {
  const pool: Node[] = new Array(NODE_COUNT);
  for (let i = 0; i < NODE_COUNT; i++) {
    pool[i] = { x: 0, y: 0, z: 0, speed: 0, size: 0, baseAlpha: 0, age: FADE_IN_FRAMES };
    initNode(pool[i], width, height, false);
  }
  return pool;
}

export function AnimatedUniverseBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Defaults to 'animate' so the common path is unchanged; the media query is
  // read in an effect, never in a render-time initializer (SSR hydration).
  const [motion, setMotion] = useState<Motion>('animate');

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      setMotion(query.matches ? 'static' : 'animate');
    };
    apply();
    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, []);

  // Keyed on `motion` so flipping the OS preference tears the whole canvas
  // effect down (cleanup cancels the outstanding frame) and rebuilds it in the
  // other mode — the reduced-motion interactions come out correct by
  // construction instead of by hand-written branches inside the loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    // The 1x cap is deliberate per-frame cost control (a full-viewport
    // clearRect + 100 arc/fill every frame); raising it needs its own
    // measurement, not a drive-by "fix".
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const nodes = createNodePool(width, height);
    let lastTime = performance.now();
    let pendingResize = false;

    // AT MOST ONE scheduled frame exists at any time, and cleanup can always
    // reach it. See `frameLoop.ts` for the leak this replaces.
    const loop = createFrameLoop(window);

    function applySize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // Assigning width/height RESETS the whole 2D context state — transform to
      // identity, fillStyle to #000, globalAlpha to 1. That is why the
      // transform is re-applied here, and why `paint()` re-sets `fillStyle`
      // every frame rather than once per effect.
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Move the pool one step. NO drawing, no scheduling. */
    function advance(dt: number) {
      const cx = width / 2;
      const cy = height / 2;
      for (let i = 0; i < NODE_COUNT; i++) {
        const node = nodes[i];
        node.z -= node.speed * dt;
        node.age += dt;

        if (node.z <= 1) {
          initNode(node, width, height, true);
          continue;
        }

        const scale = FOCAL_LENGTH / node.z;
        const sx = cx + node.x * scale;
        const sy = cy + node.y * scale;

        if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) {
          initNode(node, width, height, true);
        }
      }
    }

    /** Draw the pool as it stands. NO state advance, NO re-arm. */
    function paint() {
      const cx = width / 2;
      const cy = height / 2;

      context!.clearRect(0, 0, width, height);
      // ONE fillStyle per frame instead of one `rgba(255,255,255,${alpha})`
      // template literal + CSS colour parse per star per frame (~6000/s). Must
      // be fully OPAQUE white: any alpha here would multiply with globalAlpha
      // and darken every star. Set per FRAME, not per effect — `applySize()`
      // resets the context state (see above).
      context!.fillStyle = 'rgb(255,255,255)';

      for (let i = 0; i < NODE_COUNT; i++) {
        const node = nodes[i];
        if (node.z <= 1) continue;

        const scale = FOCAL_LENGTH / node.z;
        const sx = cx + node.x * scale;
        const sy = cy + node.y * scale;

        if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;

        const radius = node.size * (0.7 + scale * 0.1);

        // Depth-based alpha
        const depthAlpha = node.baseAlpha * (0.5 + (DEPTH - node.z) / DEPTH * 0.5);

        // Fade-in factor (0 → 1 over FADE_IN_FRAMES)
        const fadeIn = node.age >= FADE_IN_FRAMES ? 1 : node.age / FADE_IN_FRAMES;

        const alpha = Math.min(0.85, depthAlpha * fadeIn);
        if (alpha < 0.01) continue;

        context!.globalAlpha = alpha;
        context!.beginPath();
        context!.arc(sx, sy, radius, 0, Math.PI * 2);
        context!.fill();
      }

      // Identical output to the old per-node rgba fillStyle under source-over.
      // Restoring is not required for correctness (clearRect ignores
      // globalAlpha and every drawn node sets it first) — it is what keeps that
      // true for the next editor.
      context!.globalAlpha = 1;
    }

    /** Bring a fresh pool to the density the animation settles at. */
    function warmPool() {
      for (let i = 0; i < STATIC_WARMUP_FRAMES; i++) advance(1);
      // Undo the fade-in of anything re-seeded during the warm-up: a static
      // frame shows every star at full alpha.
      for (let i = 0; i < NODE_COUNT; i++) nodes[i].age = FADE_IN_FRAMES;
    }

    /** Apply a coalesced resize, if one is pending. */
    function consumeResize() {
      if (!pendingResize) return;
      pendingResize = false;
      applySize();
      // Reinitialize nodes at random depths so resize doesn't cause a flash
      for (let i = 0; i < NODE_COUNT; i++) {
        initNode(nodes[i], width, height, false);
      }
      if (motion === 'static') warmPool();
    }

    const render = (time: number) => {
      if (loop.paused) return;
      consumeResize();

      const dt = Math.min((time - lastTime) / 16.6667, MAX_DT);
      lastTime = time;

      advance(dt);
      paint();

      loop.schedule(render);
    };

    /** The static path's repaint: size + draw, never a loop. */
    const repaintOnce = () => {
      consumeResize();
      paint();
    };

    // Resize sets a FLAG; it does not schedule while the loop is running. A
    // running loop always has a frame pending, so the flag alone coalesces N
    // events into one — scheduling here would add a second concurrent handle
    // and reintroduce the very bug E1 fixes. While paused nothing is painting,
    // so the flag simply waits for the resume frame. Only the static path (no
    // loop, nothing pending) actually arms anything here; the `render` branch
    // is the safe recovery if a running loop ever finds itself unscheduled —
    // arming `repaintOnce` there would silently stop the animation.
    const resize = () => {
      pendingResize = true;
      if (loop.paused) return;
      if (loop.pending !== 0) return;
      loop.schedule(motion === 'static' ? repaintOnce : render);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        loop.pause();
        return;
      }
      // `resume()` returns false when we were not actually paused — the
      // anti-leak guard against spurious visible events. Not redundant.
      if (!loop.resume()) return;
      lastTime = performance.now();
      loop.schedule(render);
    };

    applySize();
    if (motion === 'static') {
      warmPool();
      paint();
    } else {
      loop.schedule(render);
      document.addEventListener('visibilitychange', handleVisibility);
    }
    window.addEventListener('resize', resize);

    return () => {
      loop.cancel();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [motion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      style={{ opacity: 'var(--bg-universe-opacity)', pointerEvents: 'none' }}
    />
  );
}

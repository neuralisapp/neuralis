'use client';

import { useEffect, useMemo, useState } from 'react';

type Dot = {
  x: number;
  y: number;
  size: number;
  opacity: number;
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function buildDots(count: number): Dot[] {
  const dots: Dot[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const radius = Math.sqrt(t) * 42;
    const theta = i * GOLDEN_ANGLE;
    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius;
    dots.push({
      x,
      y,
      size: 1 + (i % 3),
      opacity: 0.12 + (1 - t) * 0.35,
    });
  }
  return dots;
}

export default function FibonacciBackdrop() {
  const dots = useMemo(() => buildDots(520), []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-0 bg-[#010106]" />
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(1400px 900px at 18% 18%, rgba(78,28,132,0.34), transparent 58%), radial-gradient(1200px 760px at 84% 80%, rgba(110,24,34,0.30), transparent 54%), radial-gradient(900px 520px at 50% 54%, rgba(45,18,92,0.18), transparent 60%), linear-gradient(160deg, #080811 0%, #0d0b18 45%, #120b14 72%, #16090c 100%)',
        }}
      />

      <div
        className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-[72vmin] w-[72vmin] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          filter: 'blur(1px)',
          opacity: 0.7,
        }}
      >
        {mounted && dots.map((dot, idx) => (
          <span
            key={idx}
            className="absolute block rounded-full"
            style={{
              width: `${dot.size}px`,
              height: `${dot.size}px`,
              left: '50%',
              top: '50%',
              transform: `translate(calc(${dot.x}vmin - 50%), calc(${dot.y}vmin - 50%))`,
              background: idx % 4 === 0 ? 'rgba(84,229,255,0.5)' : 'rgba(168,85,247,0.48)',
              opacity: dot.opacity * 0.78,
              boxShadow: '0 0 8px rgba(114,79,196,0.22)',
            }}
          />
        ))}
      </div>

      <div className="pointer-events-none absolute inset-0 z-0 bg-black/40" />
    </>
  );
}

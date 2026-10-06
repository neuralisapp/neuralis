import { NextResponse } from 'next/server';
import { getBootstrapStatus, peekRuntime } from '@/server/host/bootstrap';

/** Coarse, public-safe health; never starts a runtime or reveals package errors. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const state = getBootstrapStatus();
  if (state.phase === 'error') {
    return NextResponse.json({ status: 'error', error: 'bootstrap_failed' }, { status: 503 });
  }
  const runtime = peekRuntime();
  if (state.phase !== 'ready' || !runtime) {
    return NextResponse.json({ status: 'initializing', phase: state.phase }, { status: 503 });
  }
  try {
    const health = await runtime.health();
    const ready = health.status === 'ok';
    // A refused builtin does not enter `status` (the platform runs without
    // it); the COUNT tells an orchestrator the instance is partial. Never the
    // names — Admin health names them for the operator.
    return NextResponse.json({
      status: ready ? 'ready' : 'degraded', health: health.status, refusedBuiltins: health.refused.length,
      readyAt: state.readyAt, uptimeMs: Date.now() - state.startedAt,
    }, { status: ready ? 200 : 503 });
  } catch {
    return NextResponse.json({ status: 'degraded', health: 'failed' }, { status: 503 });
  }
}

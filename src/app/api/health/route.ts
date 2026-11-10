import { NextResponse } from 'next/server';
import { getBootstrapStatus, peekRuntime } from '@/server/host/bootstrap';
import { currentInstanceId } from '@/server/host/homeLock';
import { getSetupState } from '@/server/init';

/**
 * Coarse, public-safe health; never starts a runtime or reveals package errors.
 * Every answer carries this process's random `instanceId`: the data-home lock's
 * liveness question ("is the holder still the one that wrote it?").
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // An unconfigured instance is unhealthy whatever its runtime would say; `code` is the closed reason set.
  const setup = await getSetupState();
  const instanceId = currentInstanceId();
  if (!setup.configured) return NextResponse.json({ status: 'setup_required', code: setup.reason, instanceId }, { status: 503 });
  const state = getBootstrapStatus();
  if (state.phase === 'error') {
    // `code` is a closed-set class (a data-format refusal reason, else `bootstrap_failed`);
    // the message — kind, versions, checkpoint, restore command — is the server log's alone.
    return NextResponse.json({ status: 'error', error: 'bootstrap_failed', code: state.errorCode ?? 'bootstrap_failed', instanceId }, { status: 503 });
  }
  const runtime = peekRuntime();
  if (state.phase !== 'ready' || !runtime) {
    return NextResponse.json({ status: 'initializing', phase: state.phase, instanceId }, { status: 503 });
  }
  try {
    const health = await runtime.health();
    const ready = health.status === 'ok';
    // A `degraded` package still serves (a vector store that is not reachable yet, a
    // slow health hook): 200, so compose keeps the container healthy and `up` reports
    // it. A `starting` or `failed` aggregate is not serving yet: 503.
    const serving = ready || health.status === 'degraded';
    // A refused builtin does not enter `status` (the platform runs without
    // it); the COUNT tells an orchestrator the instance is partial. Never the
    // names — Admin health names them for the operator.
    return NextResponse.json({
      status: ready ? 'ready' : 'degraded', health: health.status, refusedBuiltins: health.refused.length,
      readyAt: state.readyAt, uptimeMs: Date.now() - state.startedAt, instanceId,
    }, { status: serving ? 200 : 503 });
  } catch {
    return NextResponse.json({ status: 'degraded', health: 'failed', instanceId }, { status: 503 });
  }
}

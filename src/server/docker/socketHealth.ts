/**
 * Verifies the Docker socket is reachable at neuralis startup.
 *
 * When the socket is mounted but the daemon is not actually responding,
 * machine-core would otherwise surface this as an infinite "session
 * starting…" state in the widget. A loud, named failure at boot + a
 * widget-level "docker socket not mounted" error is more honest.
 */

type DockerodeCtor = new (opts?: { socketPath?: string }) => {
  ping(): Promise<unknown>;
};

async function loadDockerodeCtor(): Promise<DockerodeCtor | null> {
  try {
    const mod = await import('dockerode');
    const ctor = (mod as { default?: unknown }).default ?? (mod as unknown);
    return ctor as DockerodeCtor;
  } catch {
    return null;
  }
}

export type SocketHealthLogger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
};

export type SocketHealthResult =
  | { ok: true }
  | { ok: false; reason: 'module-missing' | 'ping-failed' | 'unknown'; detail?: string };

export async function verifySocketAccessible(
  socketPath: string = '/var/run/docker.sock',
  logger?: SocketHealthLogger,
): Promise<SocketHealthResult> {
  const Ctor = await loadDockerodeCtor();
  if (!Ctor) {
    const msg = '[docker] dockerode module not available — machine containers cannot spawn';
    logger?.warn(msg, { socket: socketPath });
    return { ok: false, reason: 'module-missing' };
  }
  try {
    const client = new Ctor({ socketPath });
    await client.ping();
    logger?.info('[docker] socket reachable', { socket: socketPath });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger?.error(
      '[docker] socket unreachable — machine widget will show a clean docker-missing error',
      { socket: socketPath, error: detail, runbook: 'bind-mount /var/run/docker.sock into the neuralis service and set DOCKER_GID in .env' },
    );
    return { ok: false, reason: 'ping-failed', detail };
  }
}
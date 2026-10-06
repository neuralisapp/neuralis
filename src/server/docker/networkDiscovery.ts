/**
 * Discovers the user-defined Docker network that the current neuralis
 * container runs on, so child containers (machine-core Webtops) can join it
 * and reach internal services by hostname.
 *
 * Returns `null` when neuralis is NOT running inside docker-compose (dev on
 * host, macOS Desktop, Windows). Callers must handle `null` — machine-core
 * then falls back to published host ports via NEURALIS_MACHINE_HOST_ADDRESS.
 */

import { hostname as osHostname } from 'node:os';

type DockerodeLike = {
  getContainer(id: string): {
    inspect(): Promise<{ NetworkSettings?: { Networks?: Record<string, unknown> } }>;
  };
};

export type NetworkDiscoveryLogger = {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
};

export type NetworkDiscoveryOpts = {
  /** Explicit override — takes precedence over auto-detection. */
  override?: string;
  /** Set true only when neuralis itself is running inside docker (compose). */
  isDocker?: boolean;
  logger?: NetworkDiscoveryLogger;
};

/**
 * Returns the name of the user-defined network to attach child containers to,
 * or `null` if neuralis is not in docker / detection failed / no network to share.
 */
export async function resolveSharedNetwork(
  docker: DockerodeLike,
  opts: NetworkDiscoveryOpts = {},
): Promise<string | null> {
  if (opts.override?.trim()) return opts.override.trim();
  if (!opts.isDocker) return null;

  try {
    const hn = osHostname();
    if (!hn) return null;
    const inspect = await docker.getContainer(hn).inspect();
    const networks = inspect.NetworkSettings?.Networks ?? {};
    const names = Object.keys(networks);
    if (names.length === 0) return null;
    const userDefined = names.filter((n) => n !== 'bridge' && n !== 'host' && n !== 'none');
    if (userDefined.length === 0) return null;
    if (userDefined.length === 1) return userDefined[0];
    // Multi-homed app container: first-key order is dockerd serialization
    // luck — prefer the compose default network, where child containers
    // belong. Mirrors machine-core's `resolveSharedNetworkFor` (deliberate
    // duplication; the two copies move together).
    const preferred = userDefined.find((n) => n.endsWith('_default')) ?? userDefined[0];
    opts.logger?.warn('[docker] multiple user-defined networks — preferring the compose default', {
      networks: userDefined,
      chosen: preferred,
    });
    return preferred;
  } catch (err) {
    opts.logger?.warn('[docker] Self network detection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
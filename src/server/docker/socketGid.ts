/**
 * Detects the owning GID of /var/run/docker.sock.
 *
 * docker-compose adds this as a supplementary group to the neuralis container
 * so the non-root app user can talk to the bind-mounted socket when spawning
 * per-user machine containers. Falls back to `null` on platforms where the
 * socket is not a unix socket we own (macOS Desktop, Windows) or when detection
 * fails.
 *
 * Prefer this over `getent group docker` — the daemon can be rebuilt with a
 * different group GID while the socket still carries the original one.
 */

import { stat } from 'node:fs/promises';

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';

export async function detectDockerSocketGid(socketPath: string = DEFAULT_SOCKET_PATH): Promise<number | null> {
  try {
    const info = await stat(socketPath);
    return typeof info.gid === 'number' ? info.gid : null;
  } catch {
    return null;
  }
}
import { join } from 'path';
import { isIP } from 'node:net';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { getPlatformConfigStore, type EnvInfoRow } from '../store/PlatformConfigStore';
import { HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS } from './hostConfigSettings';
import { applyConfiguredLogLevel } from '../logging/setup';
import { readSessionSecretFile, sessionSecretPath } from './sessionSecretFile';

/**
 * Env — environment-only configuration (ports, URLs, paths). The session
 * secret is a file in the data home, read by `sessionSecret()` below.
 *
 * Runtime-tunable settings (maxSteps, temperature, model, etc.) live in
 * PlatformConfigStore (~/.neuralis/app/config/platform.json) and are
 * accessed via getPlatformConfigStore().get(key).
 */
export type Env = {
  port: number;
  /** Platform data the agent must NOT access (~/.neuralis/app) */
  appRoot: string;
  /** Per-project data the agent CAN access (~/.neuralis/projects) */
  projectsRoot: string;
  nodeEnv: string;

  qdrant: {
    url: string;
  };

  /**
   * `NEURALIS_TRUSTED_PROXIES` — the reverse proxies whose `X-Forwarded-For`
   * the client-address resolver believes. Topology, not a tunable: empty (the
   * default) trusts no forwarding header at all, only the connecting socket.
   */
  trustedProxies: TrustedProxy[];

  /**
   * `NEURALIS_TUNNEL` — a tunnel connector on THIS machine dials the app over
   * loopback (`neuralis tunnel on` writes `cloudflare`). Topology, never a
   * config key: it lets the two limiters key a loopback peer by its
   * `CF-Connecting-IP`. It grants nothing — the device link never reads it.
   */
  tunnel: 'cloudflare' | null;
};

export type TrustedProxy = { network: string; prefix: number; family: 'ipv4' | 'ipv6' };

/**
 * Parse a comma- or space-separated list of addresses / CIDR blocks. ONE
 * invalid entry voids the whole list (warned) rather than trusting the rest: a
 * typo must never widen trust, and a half-applied list is a topology nobody
 * declared. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is read as IPv4.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxy[] {
  const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  const parsed: TrustedProxy[] = [];
  for (const entry of entries) {
    const [rawAddress, rawPrefix, extra] = entry.split('/');
    let address = (rawAddress ?? '').toLowerCase();
    if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
    const version = isIP(address);
    const max = version === 4 ? 32 : 128;
    const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
    if (version === 0 || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || (rawPrefix !== undefined && !/^\d+$/.test(rawPrefix))) {
      console.warn(`[env] NEURALIS_TRUSTED_PROXIES entry "${entry}" is not an address or CIDR block — trusting NO proxy`);
      return [];
    }
    parsed.push({ network: address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' });
  }
  return parsed;
}

/** The session secret file is absent: this data home is not set up (or not upgraded to keep it there). */
export class SessionSecretMissingError extends Error {
  readonly code = 'session_secret_missing' as const;
  constructor(path: string) {
    super(`The session secret ${path} is missing: run setup, or \`neuralis upgrade --apply\` on an install set up before it moved there.`);
    this.name = 'SessionSecretMissingError';
  }
}

let sessionSecretCache: string | null = null;

/**
 * The ONE reader of the session secret (`<home>/app/config/session-secret.key`,
 * `sessionSecretFile.ts`) — NextAuth's `secret` getter and the `:3101` cookie
 * decode both call it. Lazy and outside `getEnv()`: `authOptions` is a
 * module-level literal that `next build` evaluates with no data home, so the
 * value is read on the first request, then cached. It NEVER generates a
 * secret — absence is the setup-required signal (`hasSessionSecret`,
 * `init.ts`), so `ensureMasterKeyFile` / `keySetup.ts`'s generate-when-missing
 * half is not the precedent here; it throws `SessionSecretMissingError`.
 */
export function sessionSecret(): string {
  if (sessionSecretCache) return sessionSecretCache;
  const { appRoot } = resolveNeuralisHome();
  const value = readSessionSecretFile(appRoot);
  if (!value) throw new SessionSecretMissingError(sessionSecretPath(appRoot));
  sessionSecretCache = value;
  return value;
}

/** Whether the session secret file holds a secret — never generated here; setup (or the offline upgrade) writes it. */
export function hasSessionSecret(): boolean {
  return readSessionSecretFile(resolveNeuralisHome().appRoot) !== null;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const roots = resolveNeuralisHome();

  // Initialize PlatformConfigStore as side-effect (needs appRoot), register
  // the HOST's own config declarations (packages register theirs at bootstrap,
  // right before the ConfigProvider injection — see PlatformConfigStore header)
  // and feed the read-only env listing (Inc 3).
  const store = getPlatformConfigStore(roots.appRoot);
  store.registerSettings(HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS);
  store.setEnvInfo(ENV_INFO);

  cached = {
    port: parseInt(process.env.NEURALIS_APP_PORT || '3100', 10),
    appRoot: roots.appRoot,
    projectsRoot: roots.projectsRoot,
    nodeEnv: process.env.NODE_ENV || 'development',

    qdrant: {
      url: process.env.QDRANT_URL || 'http://localhost:6333',
    },

    trustedProxies: parseTrustedProxies(process.env.NEURALIS_TRUSTED_PROXIES),
    tunnel: process.env.NEURALIS_TUNNEL?.trim() === 'cloudflare' ? 'cloudflare' : null,
  };

  // Re-level the root logger from the `logLevel` platform key (Inc 2 —
  // the logger is built pre-store by instrumentation.ts; see
  // applyConfiguredLogLevel). Belt: never let a config problem break boot.
  try {
    applyConfiguredLogLevel(getPlatformConfigStore(roots.appRoot).get('logLevel'));
  } catch {
    /* env/'info' level stays */
  }

  return cached;
}

export function resetEnvCache(): void {
  cached = null;
  sessionSecretCache = null;
}

/**
 * The ONE bind address of this host's listeners — `NEURALIS_BIND_HOST`, an IP
 * literal. Unset: `0.0.0.0`, the container's own interfaces, where the port
 * publish is the boundary. The desktop app's setup writes `127.0.0.1`, and
 * `neuralis up` hands the same value to Next as `HOSTNAME`, so the app and the
 * `:3101` server bind alike. A value that is no IP literal is refused, never
 * widened to every interface.
 */
export function bindHost(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env.NEURALIS_BIND_HOST?.trim();
  if (!value) return '0.0.0.0';
  if (isIP(value) === 0) throw new Error(`NEURALIS_BIND_HOST=${value} is not an IP address; nothing was bound`);
  return value;
}

/**
 * The boot-critical env vars surfaced READ-ONLY on the admin Config tab.
 * EXPLICIT allowlist by construction — never enumerate process.env, and NEVER
 * list a var whose VALUE is a secret. An infra var whose PRESENCE is
 * operationally meaningful may appear ONLY behind a masked value getter that
 * returns '(set)'/'(unset)' and never the value — QDRANT_API_KEY is the one row
 * that uses that allowance today. The session secret is no env var at all (a
 * file, `sessionSecret`), and stays off this list forever: its presence carries
 * no operator decision.
 *
 * Values resolve at listing time. Categories must NOT be 'vector' (the flat
 * Config list filters that category out — it belongs to the Vector tab).
 */
export const ENV_INFO: EnvInfoRow[] = [
  { name: 'NEURALIS_APP_PORT', label: 'App Port', description: 'Port the neuralis app listens on', category: 'general', value: () => String(process.env.NEURALIS_APP_PORT || '3100') },
  { name: 'NODE_ENV', label: 'Environment', description: 'Node.js environment mode', category: 'general', value: () => process.env.NODE_ENV || 'development' },
  // A deployment has to be able to say what it is. Baked into the image from
  // the build args; absent on a source run, where the checkout is the answer.
  { name: 'NEURALIS_VERSION', label: 'Version', description: 'Version this deployment runs (the image\'s build, or the desktop app\'s host package; a source checkout reports its own tree)', category: 'general', value: () => process.env.NEURALIS_VERSION || '(source checkout)' },
  { name: 'NEURALIS_REVISION', label: 'Revision', description: 'Commit this image was built from', category: 'general', value: () => process.env.NEURALIS_REVISION || '(unknown)' },
  { name: 'NEXTAUTH_URL', label: 'Auth URL', description: 'NextAuth callback URL. REQUIRED for any non-localhost deployment (LAN IP, hostname, domain) — unset, the app answers on loopback at its own port, a dev convenience that works on no other address', category: 'auth', value: () => process.env.NEXTAUTH_URL?.trim() || '(unset)' },
  { name: 'NEURALIS_TRUSTED_PROXIES', label: 'Trusted Proxies', description: 'Reverse proxies (addresses / CIDR) whose X-Forwarded-For the login lockout and the webhook cap believe. Empty = only the connecting socket counts; set by setup, applies on restart', category: 'auth', value: () => process.env.NEURALIS_TRUSTED_PROXIES?.trim() || '(none)' },
  { name: 'NEURALIS_TUNNEL', label: 'Tunnel', description: 'A tunnel connector on this machine (`neuralis tunnel on`): the login lockout and the webhook cap key its loopback requests by CF-Connecting-IP; applies on restart', category: 'auth', value: () => process.env.NEURALIS_TUNNEL?.trim() || '(none)' },
  { name: 'QDRANT_URL', label: 'Qdrant URL', description: 'Vector database endpoint (boot-critical infra)', category: 'brain', value: () => process.env.QDRANT_URL || 'http://localhost:6333' },
  { name: 'QDRANT_API_KEY', label: 'Qdrant API Key', description: 'API key for an authenticated Qdrant (boot-critical infra — the client is built synchronously at boot, so this is env, not a credential)', category: 'brain', value: () => (process.env.QDRANT_API_KEY?.trim() ? '(set)' : '(unset)') },
  // Unset means what brain-core does with it (`wiring.ts`: in-memory), never a second default.
  { name: 'BRAIN_INFRA_MODE', label: 'Infra Mode', description: 'Brain filesystem infrastructure mode (unset: inmemory)', category: 'brain', value: () => process.env.BRAIN_INFRA_MODE?.trim() || 'inmemory' },
  { name: 'MCP_HTTP_PORT', label: 'MCP HTTP Port', description: 'MCP HTTP server port', category: 'mcp', value: () => String(process.env.MCP_HTTP_PORT || '3101') },
  { name: 'NEURALIS_BIND_HOST', label: 'Bind Address', description: 'The one address the app and the MCP server listen on (the desktop app: 127.0.0.1; unset in a container: every interface, the port publish is the boundary). `neuralis up` hands it to the app as HOSTNAME', category: 'general', value: () => process.env.NEURALIS_BIND_HOST?.trim() || '0.0.0.0' },
  { name: 'APP_URL', label: 'App URL', description: 'Public application URL for OAuth callbacks. REQUIRED for any non-localhost deployment — must match the origin users actually reach', category: 'mcp', value: () => process.env.APP_URL?.trim() || '(unset)' },
  { name: 'MCP_BASE_URL', label: 'MCP Base URL', description: 'MCP server base URL advertised to external clients. Set it for any non-localhost deployment', category: 'mcp', value: () => process.env.MCP_BASE_URL?.trim() || '(unset)' },
];

export function resolveProjectPackagesDir(projectRoot: string): string {
  return join(projectRoot, '_packages');
}

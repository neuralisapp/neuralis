import { join } from 'path';
import { isIP } from 'node:net';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { getPlatformConfigStore, type EnvInfoRow } from '../store/PlatformConfigStore';
import { HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS } from './hostConfigSettings';
import { applyConfiguredLogLevel } from '../logging/setup';

/**
 * Env — environment-only configuration (ports, URLs, paths, master secret).
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

  auth: {
    secret: string;
    nextAuthUrl: string;
    adminEmail: string | null;
  };

  mcp: {
    httpPort: number;
    baseUrl: string;
    appUrl: string;
  };

  /**
   * `NEURALIS_TRUSTED_PROXIES` — the reverse proxies whose `X-Forwarded-For`
   * the client-address resolver believes. Topology, not a tunable: empty (the
   * default) trusts no forwarding header at all, only the connecting socket.
   */
  trustedProxies: TrustedProxy[];
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

function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. ${hint}`);
  }
  return value;
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

    auth: {
      secret: requireEnv('NEXTAUTH_SECRET', 'Required for session security. Generate with: openssl rand -base64 32'),
      nextAuthUrl: process.env.NEXTAUTH_URL || 'http://localhost:3100',
      adminEmail: process.env.NEURALIS_ADMIN_EMAIL?.trim() || null,
    },

    mcp: {
      httpPort: parseInt(process.env.MCP_HTTP_PORT || '3101', 10),
      baseUrl: process.env.MCP_BASE_URL || 'http://localhost:3101',
      appUrl: process.env.APP_URL || 'http://localhost:3100',
    },

    trustedProxies: parseTrustedProxies(process.env.NEURALIS_TRUSTED_PROXIES),
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
}

/**
 * The boot-critical env vars surfaced READ-ONLY on the admin Config tab.
 * EXPLICIT allowlist by construction — never enumerate process.env, and NEVER
 * list a var whose VALUE is a secret. An infra var whose PRESENCE is
 * operationally meaningful may appear ONLY behind a masked value getter that
 * returns '(set)'/'(unset)' and never the value — QDRANT_API_KEY is the one row
 * that uses that allowance today. NEXTAUTH_SECRET stays off this list forever:
 * its presence carries no operator decision.
 *
 * Values resolve at listing time. Categories must NOT be 'vector' (the flat
 * Config list filters that category out — it belongs to the Vector tab).
 */
export const ENV_INFO: EnvInfoRow[] = [
  { name: 'NEURALIS_APP_PORT', label: 'App Port', description: 'Port the neuralis app listens on', category: 'general', value: () => String(process.env.NEURALIS_APP_PORT || '3100') },
  { name: 'NODE_ENV', label: 'Environment', description: 'Node.js environment mode', category: 'general', value: () => process.env.NODE_ENV || 'development' },
  // A deployment has to be able to say what it is. Baked into the image from
  // the build args; absent on a source run, where the checkout is the answer.
  { name: 'NEURALIS_VERSION', label: 'Version', description: 'Version this deployment was built from (image builds only; a source checkout reports its own tree)', category: 'general', value: () => process.env.NEURALIS_VERSION || '(source checkout)' },
  { name: 'NEURALIS_REVISION', label: 'Revision', description: 'Commit this image was built from', category: 'general', value: () => process.env.NEURALIS_REVISION || '(unknown)' },
  { name: 'NEXTAUTH_URL', label: 'Auth URL', description: 'NextAuth callback URL. REQUIRED for any non-localhost deployment (LAN IP, hostname, domain) — the localhost default is a dev convenience, not a fallback that works remotely', category: 'auth', value: () => process.env.NEXTAUTH_URL || 'http://localhost:3100' },
  { name: 'NEURALIS_TRUSTED_PROXIES', label: 'Trusted Proxies', description: 'Reverse proxies (addresses / CIDR) whose X-Forwarded-For the login lockout and the webhook cap believe. Empty = only the connecting socket counts; set by setup, applies on restart', category: 'auth', value: () => process.env.NEURALIS_TRUSTED_PROXIES?.trim() || '(none)' },
  { name: 'NEURALIS_ADMIN_EMAIL', label: 'Admin Email', description: 'Bootstrap owner account email (setup-provisioned)', category: 'auth', value: () => process.env.NEURALIS_ADMIN_EMAIL?.trim() || '(unset)' },
  { name: 'QDRANT_URL', label: 'Qdrant URL', description: 'Vector database endpoint (boot-critical infra)', category: 'brain', value: () => process.env.QDRANT_URL || 'http://localhost:6333' },
  { name: 'QDRANT_API_KEY', label: 'Qdrant API Key', description: 'API key for an authenticated Qdrant (boot-critical infra — the client is built synchronously at boot, so this is env, not a credential)', category: 'brain', value: () => (process.env.QDRANT_API_KEY?.trim() ? '(set)' : '(unset)') },
  { name: 'BRAIN_INFRA_MODE', label: 'Infra Mode', description: 'Brain filesystem infrastructure mode', category: 'brain', value: () => process.env.BRAIN_INFRA_MODE || 'local' },
  { name: 'MCP_HTTP_PORT', label: 'MCP HTTP Port', description: 'MCP HTTP server port', category: 'mcp', value: () => String(process.env.MCP_HTTP_PORT || '3101') },
  { name: 'APP_URL', label: 'App URL', description: 'Public application URL for OAuth callbacks. REQUIRED for any non-localhost deployment — must match the origin users actually reach', category: 'mcp', value: () => process.env.APP_URL || 'http://localhost:3100' },
  { name: 'MCP_BASE_URL', label: 'MCP Base URL', description: 'MCP server base URL advertised to external clients. Set it for any non-localhost deployment', category: 'mcp', value: () => process.env.MCP_BASE_URL || 'http://localhost:3101' },
];

export function resolveProjectPackagesDir(projectRoot: string): string {
  return join(projectRoot, '_packages');
}

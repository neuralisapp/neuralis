/**
 * PlatformConfigStore — persistent JSON config at ~/.neuralis/app/config/platform.json.
 *
 * A pure REGISTRY + CASCADE engine (tunable-tanager Inc 1): the store holds NO
 * hardcoded schema. Every key is DECLARED — first-party packages via manifest
 * `neuralis.configSettings[]` (collected at bootstrap through the agent-core
 * `collectDeclaredPackageConfigSettings()` API), the host's own residual keys
 * via `hostConfigSettings.ts` (registered inside `getEnv()`). The cascade per
 * key is unchanged: file override → `envFallback` env var → declared default.
 *
 * Registration is BOOT-FROZEN: host keys register at store construction time
 * (`getEnv()`), package keys once at bootstrap right before the ConfigProvider
 * injection; a project package rescan does NOT re-register (first-party
 * builtin declarations only change with a restart). `resetPlatformConfigStore()`
 * therefore yields an EMPTY registry — tests must self-register synthetic
 * settings (pair it with `resetEnvCache()`; `getEnv()` re-registers the host
 * keys on the next call).
 *
 * The singleton is anchored on `globalThis` (same mechanism as
 * `credentialStoreInstance.ts`) and NOT on a module-level `let`. Next.js
 * compiles `instrumentation.ts` — which runs `bootstrap()`, the ONLY place
 * package `configSettings[]` are registered — into a different bundle from the
 * `/api/**` route handlers, so a module-local singleton produced TWO stores per
 * process: the bootstrap one with every package key, and a route-local one that
 * `getEnv()` had populated with the HOST keys alone. Every host route reading a
 * PACKAGE-declared key then threw `Config key not registered` while host keys
 * (`maxProjects`) resolved fine — which is exactly how the operator-endpoint
 * route 500'd for every caller, owner included. Do not "simplify" this back to a
 * module-level `let`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isValidConfigKey,
  type PackageConfigSetting,
} from '@neuralis/package-system/contracts';
import { durableReplaceFileSync } from '@neuralis/package-system/data';

/**
 * The host-READ keys, typed for ergonomic `get()` calls in host code. This is
 * NOT a schema (the registry is the schema) — just compile-time sugar for the
 * keys host modules read directly. `logLevel` re-levels the root logger at
 * the end of `getEnv()` (applies on restart — see logging/setup.ts
 * `applyConfiguredLogLevel`).
 */
export type KnownPlatformConfig = {
  maxProjects: number;
  logLevel: string;
};

/** A registered schema row: the declaration + who declared it. */
export type RegisteredConfigSetting = PackageConfigSetting & { declaredBy: string };

/** Where a key's effective value comes from right now. */
export type ConfigValueSource = 'default' | 'env' | 'override';

/**
 * A boot-critical env var surfaced READ-ONLY on the admin Config tab
 * (tunable-tanager Inc 3). Explicit allowlist-by-construction — the host
 * feeds `ENV_INFO` (env.ts) at `getEnv()` time; there is NO env enumeration,
 * so a secret var can never leak into the listing by pattern accident.
 * `value` is a getter, resolved at `listEnvInfo()` call time.
 */
export type EnvInfoRow = {
  name: string;
  label: string;
  description: string;
  category: string;
  value: () => string;
};

// ---------------------------------------------------------------------------
// Typed patch error
// ---------------------------------------------------------------------------

/**
 * Stable, narrowable reason a {@link PlatformConfigStore.patch} call rejected.
 * This is the typed contract the admin config-PATCH route consumes — it lets
 * the downstream `ConfigStoreAccessor.patch` consumer narrow on `err.code`
 * instead of string-matching `err.message` (admin TS-2/C10). The values are
 * the stable contract; do not rename without updating the admin consumer.
 */
export type ConfigPatchErrorCode = 'unknown_key' | 'read_only' | 'invalid_value';

/** Typed error thrown by {@link PlatformConfigStore.patch}. The message stays
 *  human-readable (and keeps the legacy 'read-only'/'Unknown' substrings for
 *  back-compat with the not-yet-migrated string-match consumer); `code` is the
 *  forward contract. */
export class ConfigPatchError extends Error {
  readonly code: ConfigPatchErrorCode;
  constructor(code: ConfigPatchErrorCode, message: string) {
    super(message);
    this.name = 'ConfigPatchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PlatformConfigStore {
  private readonly filePath: string;
  private cache: Record<string, unknown> | null = null;
  private readonly registry = new Map<string, RegisteredConfigSetting>();

  constructor(appRoot: string) {
    this.filePath = join(appRoot, 'config', 'platform.json');
  }

  /**
   * Register a declarer's config settings. Boot-time only (see header).
   * - malformed key / min-max-default sanity failure → throw (build bug);
   * - CROSS-declarer key collision → throw (the flat namespace is single-owner);
   * - same-declarer re-registration → idempotent replace (dev restarts).
   */
  registerSettings(declarer: string, settings: PackageConfigSetting[]): void {
    for (const setting of settings) {
      if (!isValidConfigKey(setting.key)) {
        throw new Error(
          `registerSettings(${declarer}): malformed config key "${setting.key}" ` +
          `(flat camelCase, ^[a-z][a-zA-Z0-9]{0,63}$)`,
        );
      }
      if (setting.type !== 'number' && (setting.min !== undefined || setting.max !== undefined)) {
        throw new Error(
          `registerSettings(${declarer}): "${setting.key}" — min/max only valid on type 'number'`,
        );
      }
      if (setting.type === 'number') {
        const { min, max } = setting;
        const d = setting.default;
        if (min !== undefined && max !== undefined && min > max) {
          throw new Error(`registerSettings(${declarer}): "${setting.key}" — min > max`);
        }
        if (typeof d === 'number' && ((min !== undefined && d < min) || (max !== undefined && d > max))) {
          throw new Error(`registerSettings(${declarer}): "${setting.key}" — default out of [min, max]`);
        }
      }
      const existing = this.registry.get(setting.key);
      if (existing && existing.declaredBy !== declarer) {
        throw new Error(
          `registerSettings(${declarer}): config key "${setting.key}" already declared by ` +
          `"${existing.declaredBy}" — the flat config namespace is single-owner per key`,
        );
      }
      this.registry.set(setting.key, { ...setting, declaredBy: declarer });
    }
  }

  /** All registered keys (json-type included — unlike `getAllSettings`). */
  listRegisteredKeys(): string[] {
    return [...this.registry.keys()];
  }

  /** The registered schema row for a key, if any (drift tests, admin detail). */
  getRegisteredSetting(key: string): RegisteredConfigSetting | undefined {
    return this.registry.get(key);
  }

  /**
   * The base every WRITE merges into, read from DISK and never from the cache:
   * an edit made out of band since the cache filled (by hand, by a setup
   * re-run, by a checkpoint restore) survives a patch of another key instead of
   * being overwritten with the cached map. The read-merge-write is one
   * synchronous run, so no other write in this process can land in between.
   * A missing file is an empty map; an unreadable one REFUSES the write — merging
   * into `{}` would erase every key on disk but the one being set.
   */
  private readOverridesForWrite(): Record<string, unknown> {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('platform.json is not a JSON object; refusing to overwrite it — fix or remove the file first');
    }
    return parsed as Record<string, unknown>;
  }

  /** Read raw overrides from disk (cached). */
  private readOverrides(): Record<string, unknown> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      this.cache = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  /** Get effective value: file override > env fallback > declared default. */
  get<K extends keyof KnownPlatformConfig>(key: K): KnownPlatformConfig[K];
  get(key: string): unknown;
  get(key: string): unknown {
    const schema = this.registry.get(key);
    if (!schema) {
      throw new Error(
        `Config key not registered: "${key}" — declare it in a package manifest ` +
        `configSettings[] (or hostConfigSettings) before reading. Reads are lazy; ` +
        `a boot-time read of a package key is an ordering bug.`,
      );
    }

    const overrides = this.readOverrides();
    if (key in overrides && overrides[key] !== undefined) {
      return overrides[key];
    }

    if (schema.envFallback) {
      const envVal = process.env[schema.envFallback];
      if (envVal !== undefined && envVal !== '') {
        return coerce(envVal, schema.type, schema.default);
      }
    }

    return schema.default;
  }

  /** Where a key's effective value comes from (admin display). */
  private valueSource(schema: RegisteredConfigSetting): ConfigValueSource {
    const overrides = this.readOverrides();
    if (schema.key in overrides && overrides[schema.key] !== undefined) return 'override';
    if (schema.envFallback) {
      const envVal = process.env[schema.envFallback];
      if (envVal !== undefined && envVal !== '') return 'env';
    }
    return 'default';
  }

  /** Update a single key. Validates type + number bounds, writes atomically. */
  patch(key: string, value: unknown): void {
    const schema = this.registry.get(key);
    if (!schema) throw new ConfigPatchError('unknown_key', `Unknown config key: ${key}`);
    if (schema.editable === false) throw new ConfigPatchError('read_only', `Config key ${key} is read-only`);

    // Validate value type matches schema
    const coerced = coerceAndValidate(value, schema.type);
    if (coerced === undefined) {
      throw new ConfigPatchError(
        'invalid_value',
        `Invalid value for ${key}: expected ${schema.type}, got ${typeof value}`,
      );
    }
    if (schema.type === 'number' && typeof coerced === 'number') {
      if (schema.min !== undefined && coerced < schema.min) {
        throw new ConfigPatchError(
          'invalid_value',
          `Invalid value for ${key}: ${coerced} is below the minimum ${schema.min}`,
        );
      }
      if (schema.max !== undefined && coerced > schema.max) {
        throw new ConfigPatchError(
          'invalid_value',
          `Invalid value for ${key}: ${coerced} is above the maximum ${schema.max}`,
        );
      }
    }

    const overrides = { ...this.readOverridesForWrite(), [key]: coerced };
    this.writeAtomic(overrides);
    this.cache = overrides;
  }

  /**
   * Remove a key's FILE OVERRIDE so the cascade falls back to the next layer —
   * the declared `envFallback` when it resolves, else the declared default.
   * "Reset" therefore does NOT mean "default": an env-backed key reads back
   * with `valueSource: 'env'`, and only the file layer is ever touched.
   * Idempotent — resetting a key with no override writes nothing and succeeds.
   */
  removeOverride(key: string): void {
    const schema = this.registry.get(key);
    if (!schema) throw new ConfigPatchError('unknown_key', `Unknown config key: ${key}`);
    if (schema.editable === false) throw new ConfigPatchError('read_only', `Config key ${key} is read-only`);
    const overrides = this.readOverridesForWrite();
    this.cache = overrides;
    if (!(key in overrides)) return;
    const next = { ...overrides };
    delete next[key];
    this.writeAtomic(next);
    this.cache = next;
  }

  
  /**
   * Return all settings with effective values (for admin API). Excludes `json`
   * entries — those have dedicated editors. Deterministic order: category,
   * then key (the registry Map order is registration order, which must not
   * leak into the UI).
   */
  getAllSettings(): Array<{
    key: string;
    label: string;
    description: string;
    value: string | number | boolean;
    type: 'string' | 'number' | 'boolean';
    editable: boolean;
    category: string;
    declaredBy: string;
    valueSource: ConfigValueSource;
    min?: number;
    max?: number;
  }> {
    return [...this.registry.values()]
      .filter((schema) => schema.type !== 'json')
      .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key))
      .map((schema) => ({
        key: schema.key,
        label: schema.label,
        description: schema.description ?? '',
        value: this.get(schema.key) as string | number | boolean,
        type: schema.type as 'string' | 'number' | 'boolean',
        editable: schema.editable !== false,
        category: schema.category,
        declaredBy: schema.declaredBy,
        valueSource: this.valueSource(schema),
        ...(schema.min !== undefined ? { min: schema.min } : {}),
        ...(schema.max !== undefined ? { max: schema.max } : {}),
      }));
  }

  /** Host-fed read-only env rows (see EnvInfoRow). Empty until getEnv() runs. */
  private envInfo: EnvInfoRow[] = [];

  /** Called from getEnv() with the explicit ENV_INFO allowlist (reset pairing:
   *  resetPlatformConfigStore() empties this too; the next getEnv() re-feeds). */
  setEnvInfo(rows: EnvInfoRow[]): void {
    this.envInfo = rows;
  }

  /**
   * The boot-critical env vars as READ-ONLY settings rows for the admin Config
   * tab — full PlatformSetting shape (`valueSource:'env'`, `declaredBy:'env'`,
   * `editable:false`) so the tab renders them uniformly with registry rows.
   */
  listEnvInfo(): Array<{
    key: string;
    label: string;
    description: string;
    value: string;
    type: 'string';
    editable: false;
    category: string;
    declaredBy: 'env';
    valueSource: 'env';
  }> {
    return this.envInfo.map((row) => ({
      key: row.name,
      label: row.label,
      description: row.description,
      value: row.value(),
      type: 'string' as const,
      editable: false as const,
      category: row.category,
      declaredBy: 'env' as const,
      valueSource: 'env' as const,
    }));
  }

  /** Clear in-memory override cache (forces re-read from disk on next access). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * The kernel's crash-durable replace (exclusive pid+counter temp, file fsync,
   * rename, directory fsync), in its SYNC form: `patch` stays synchronous
   * because admin calls it un-awaited. A failure leaves the disk holding the
   * old or the new file, so the cache is dropped and the next read goes to disk.
   */
  private writeAtomic(data: Record<string, unknown>): void {
    try {
      durableReplaceFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.cache = null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** The ONE process-wide slot. Anchored on globalThis so every webpack bundle
 *  (routes, instrumentation/bootstrap, in-process builtin packages) shares the
 *  SAME registry — see the module header for what a module-local `let` broke. */
type GlobalSlot = { __neuralis_platform_config_store__?: PlatformConfigStore };
const slot = globalThis as GlobalSlot;

export function getPlatformConfigStore(appRoot?: string): PlatformConfigStore {
  if (!slot.__neuralis_platform_config_store__) {
    if (!appRoot) throw new Error('PlatformConfigStore not initialized — appRoot required on first call');
    slot.__neuralis_platform_config_store__ = new PlatformConfigStore(appRoot);
  }
  return slot.__neuralis_platform_config_store__;
}

export function resetPlatformConfigStore(): void {
  slot.__neuralis_platform_config_store__ = undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate and coerce a value for patch(). Returns undefined if invalid. */
function coerceAndValidate(value: unknown, type: 'number' | 'string' | 'boolean' | 'json'): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      return undefined;
    }
    case 'string':
      return typeof value === 'string' ? value : String(value ?? '');
    case 'json': {
      // Accept arrays and plain objects; reject primitives.
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') return value;
      // Allow stringified JSON — useful for admin API patch via form fields.
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) return parsed;
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Coerce a string env var to the expected type. */
function coerce(value: string, type: 'number' | 'string' | 'boolean' | 'json', fallback: unknown): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
    case 'boolean':
      return value === 'true' || value === '1';
    case 'json':
      // JSON keys have no env fallback — only from platform.json.
      return fallback;
    default:
      return value;
  }
}

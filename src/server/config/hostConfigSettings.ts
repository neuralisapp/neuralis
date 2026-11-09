import type { PackageConfigSetting } from '@neuralis/package-system/contracts';

/**
 * The HOST's own platform-config declarations — registered through the SAME
 * `registerSettings` mechanism every native package uses (declarer
 * `'host'`), so the store carries ZERO hardcoded schema. Only genuinely
 * host-owned keys belong here (project capacity, host logging); every
 * agent/brain/machine tunable is declared by its owning package's manifest
 * `neuralis.configSettings[]`.
 */
export const HOST_CONFIG_DECLARER = 'host';

export const HOST_CONFIG_SETTINGS: PackageConfigSetting[] = [
  {
    key: 'maxProjects',
    label: 'Max Projects',
    description: 'Maximum projects per instance (0 = unlimited)',
    type: 'number',
    default: 1,
    envFallback: 'NEURALIS_MAX_PROJECTS',
    category: 'enterprise',
  },
  {
    key: 'logLevel',
    label: 'Log Level',
    description:
      'DOCKER/console log level (debug/info/warn/error/silent) — what `docker logs` shows. It is NOT stored on disk and is lost on container restart, and it does NOT affect the file logs: those are "Package Log Level" (data://<package>/logs/*.jsonl) and "Route Log Level" (app/logs/routes.jsonl), both of which apply live; which route-log lines also reach this console is "Route Console Log Level". Applies on restart — the root logger re-levels from this key at boot (early bootstrap lines use the LOG_LEVEL env value).',
    type: 'string',
    default: 'info',
    envFallback: 'LOG_LEVEL',
    category: 'debug',
  },
  {
    key: 'routeLogLevel',
    label: 'Route Log Level',
    description:
      'Level for app/logs/routes.jsonl — one structured line per package-route dispatch (pattern, method, status, ms, caller, denial reason). Unless "Route Console Log Level" is set, every line this level admits is ALSO written to the Docker console (`docker logs`, subject to "Log Level"). Defaults to warn, which records denials, faults and slow requests (see "Route Slow Threshold"): several UI surfaces poll every few seconds through the dispatcher, so one open shell tab alone writes ~34k lines/day and info-level retention collapses to hours. Raise to info for a debugging window; it applies LIVE, no restart. Separate from the Docker "Log Level" and from "Package Log Level".',
    type: 'string',
    default: 'warn',
    category: 'debug',
  },
  {
    key: 'routeConsoleLogLevel',
    label: 'Route Console Log Level',
    description:
      'Which route-log lines ALSO reach the Docker console (`docker logs`): info, warn, error or silent. Empty (the default) follows "Route Log Level", so the console carries exactly the lines app/logs/routes.jsonl gets. Set it to split the two — e.g. Route Log Level info + this warn keeps every request in the file and only denials, faults and slow requests in `docker logs`. `debug` behaves as `info` (the route log writes no debug lines); any other value counts as empty. Still subject to "Log Level". Applies LIVE, no restart.',
    type: 'string',
    default: '',
    category: 'debug',
  },
  {
    key: 'routeSlowMs',
    label: 'Route Slow Threshold (ms)',
    description:
      'A package-route dispatch that takes at least this long is logged at warn with slow: true, whatever its status — so a slow successful request reaches app/logs/routes.jsonl and `docker logs` at the default Route Log Level. The line carries the matched route pattern and timing, never the request path, query or body. Applies LIVE, no restart.',
    type: 'number',
    default: 1_000,
    min: 50,
    max: 600_000,
    category: 'debug',
  },
  {
    key: 'perfEventLoopLagWarnMs',
    label: 'Event-Loop Lag Warning (ms)',
    description:
      "The host process monitor writes one perf.slow warning (kind eventloop) to `docker logs` when the longest single event-loop stall in a sample window reaches this (the window's p99 rides along as context). The measured delay includes the monitor's 20 ms sampling resolution, so an idle process reads ~20-30 ms. Applies live, at the next sample.",
    type: 'number',
    default: 200,
    min: 20,
    max: 60_000,
    category: 'debug',
  },
  {
    key: 'perfProcessCpuWarnPercent',
    label: 'Process CPU Warning (%)',
    description:
      "The host process monitor writes one perf.slow warning (kind process) to `docker logs` when the Node process's CPU over a sample window exceeds this. 100 = one full core; it is the Node process with all its threads, NOT the container (Qdrant and other containers are measured with `docker stats`). Applies live, at the next sample.",
    type: 'number',
    default: 80,
    min: 10,
    max: 800,
    category: 'debug',
  },
  {
    key: 'perfSampleIntervalMs',
    label: 'Process Monitor Interval (ms)',
    description:
      "Length of the host process monitor's sample window (event-loop lag and process CPU are each evaluated once per window). Applies on restart — the timer is armed once at server start.",
    type: 'number',
    default: 30_000,
    min: 5_000,
    max: 600_000,
    category: 'debug',
  },
  {
    key: 'routeLogMaxBytes',
    label: 'Route Log Max (bytes)',
    description:
      'Rotation threshold for app/logs/routes.jsonl. The 25 MB x 5 default buys ~125 MB of denials, faults and slow requests — months at the warn default, hours if you leave the level at info on a busy instance.',
    type: 'number',
    default: 26_214_400,
    min: 1_048_576,
    max: 524_288_000,
    category: 'debug',
  },
  {
    key: 'routeLogMaxFiles',
    label: 'Route Log Max Files',
    description: 'Rotated generations kept for app/logs/routes.jsonl. With the size threshold above, this is the whole retention: 25 MB x 5 = 125 MB of denials, faults and slow requests.',
    type: 'number',
    default: 5,
    min: 1,
    max: 20,
    category: 'debug',
  },
  {
    key: 'routeLogMaxAgeDays',
    label: 'Route Log Max Age (days)',
    description: 'Age sweep for app/logs/routes.jsonl and its rotated generations. Its own key rather than the package one, so the route log is never swept on a schedule set for a different file.',
    type: 'number',
    default: 90,
    min: 1,
    max: 3650,
    category: 'debug',
  },
  {
    key: 'auditLogMaxBytes',
    label: 'Audit Log Rotation (bytes)',
    description:
      'Size at which app/logs/audit.jsonl rotates. Rotation only RENAMES — audit.jsonl.1 is the newest generation and every older one is kept; no audit record is ever deleted. The size bounds how much one read of the newest audit rows has to parse. Applies live.',
    type: 'number',
    default: 26_214_400,
    min: 1_048_576,
    max: 524_288_000,
    category: 'debug',
  },
  {
    key: 'sseHeartbeatMs',
    label: 'SSE Heartbeat (ms)',
    description:
      'Keepalive frame interval on the multiplexed /api/events SSE hub; keeps HTTP/1.1 intermediaries and the browser\'s staleness watchdog (60 s) from dropping an idle connection. Applies to newly opened connections.',
    type: 'number',
    default: 25_000,
    min: 5_000,
    max: 55_000,
    category: 'runtime',
  },
  {
    key: 'presenceActiveWindowMs',
    label: 'Presence Active Window (ms)',
    description:
      'How long a client that called the API with an access token (the neuralis CLI, an MCP client) still counts as online after its last request. An open workspace window counts as online for as long as it is connected. Presence is kept in memory only. Applies live.',
    type: 'number',
    default: 300_000,
    min: 30_000,
    max: 3_600_000,
    category: 'runtime',
  },
  {
    key: 'presenceSignalCooldownMs',
    label: 'Presence Signal Cooldown (ms)',
    description:
      'The shortest gap between two "who is online changed" signals for one project on the live event hub. A change inside the gap is sent once when it ends. Applies live.',
    type: 'number',
    default: 5_000,
    min: 1_000,
    max: 60_000,
    category: 'runtime',
  },
  {
    key: 'webhookRateLimitPerMinute',
    label: 'Webhook Rate Limit / Minute',
    description:
      'Per-client-address request limit per minute on the webhook gateway (the connecting socket, or the X-Forwarded-For hop a proxy declared in NEURALIS_TRUSTED_PROXIES wrote — behind an undeclared proxy or tunnel this is one shared cap) (channel ingress + workflow fire endpoint); the limiter runs before signature/bearer verification as the outer wall against connection-id enumeration.',
    type: 'number',
    default: 60,
    min: 10,
    max: 1_200,
    category: 'channels',
  },
  {
    key: 'mcpHttpBodyMaxKb',
    label: 'MCP HTTP Body Max (KB)',
    description:
      'Max request body size the community MCP HTTP server parses for /mcp JSON-RPC and OAuth routes. Applies on restart.',
    type: 'number',
    default: 256,
    min: 16,
    max: 4_096,
    category: 'mcp',
  },
  {
    key: 'sessionMaxAgeSeconds',
    label: 'Session Max Age (seconds)',
    description:
      'NextAuth JWT session lifetime for the whole web app; shorten to meet SSO/compliance policies (the 30-day ceiling cannot be raised). Applies to newly issued sessions.',
    type: 'number',
    default: 2_592_000,
    min: 3_600,
    max: 2_592_000,
    category: 'enterprise',
  },
  {
    key: 'inviteLinkTtlHours',
    label: 'Invite Link Lifetime (hours)',
    description:
      'How long an invite link (Admin → Users → Copy invite link, or an agent with the invite skill) can be used. A link works once, only for the email it was made for, and only while the person who made it may still invite into that role. Applies to links made after the change.',
    type: 'number',
    default: 168,
    min: 1,
    max: 720,
    category: 'enterprise',
  },
  {
    key: 'dataCheckpointKeep',
    label: 'Data Checkpoints Kept',
    description:
      'Retention count for control-plane checkpoints under <NEURALIS_HOME>/checkpoints/; restoring one (`npx neuralis checkpoint restore <id>`, app stopped) is how an operator goes back to the previous build. The running app takes no checkpoint: a stored data format is raised only by `npx neuralis upgrade --apply`, which takes its own before it writes and then prunes the checkpoints to this count.',
    type: 'number',
    default: 5,
    min: 1,
    max: 50,
    category: 'enterprise',
  },
  {
    key: 'notificationsMaxRowsPerUser',
    label: 'Notifications Kept per User',
    description:
      'How many notification rows one user keeps per project (projects/<id>/notifications/<user>/log.jsonl). Past it the oldest rows are dropped when the next notification is written — there is no background sweep. Applies live.',
    type: 'number',
    default: 500,
    min: 50,
    max: 5_000,
    category: 'runtime',
  },
  {
    key: 'notificationsRetentionDays',
    label: 'Notification Retention (days)',
    description:
      'Notifications older than this are dropped when the user next receives one (no background sweep, so an idle inbox keeps its rows until then). Applies live.',
    type: 'number',
    default: 30,
    min: 1,
    max: 365,
    category: 'runtime',
  },
  {
    key: 'disabledBuiltinPackages',
    label: 'Turned-off Core Packages',
    description:
      'Core packages this deployment does not load, as a JSON list. Only a package whose manifest says the platform runs without it can be turned off — today "@neuralis/machine-core" (the virtual desktop); any other entry is ignored and named in the log, and a value that is no list of names turns nothing off. Turned off, it leaves out the virtual desktop, machine_use, the shell inside desktops, sidecar MCP servers and the desktop sources (they stay stored and come back when it is on again); the package stays installed. Applies on restart. Setup writes it for a new install without Docker; the setting covers every install on this data folder.',
    type: 'json',
    default: [],
    category: 'runtime',
  },
  {
    key: 'sourcePackageScanMaxFiles',
    label: 'Source Package Scan Max Files',
    description:
      'Max files walked per source-package / project _packages drop during package-source discovery; the walk stops silently at the cap. Applies to newly scanned packages.',
    type: 'number',
    default: 200,
    min: 50,
    max: 2_000,
    category: 'runtime',
  },
  {
    key: 'sourcePackageInlineMaxKb',
    label: 'Source Package Inline Max (KB)',
    description:
      'Per-file inline-content cap for prompt-injectable categories (instructions/rules/skills/agents/docs) of discovered source packages; larger files truncate with a marker. Applies to newly scanned packages.',
    type: 'number',
    default: 64,
    min: 4,
    max: 256,
    category: 'runtime',
  },
  {
    key: 'packageRegistryUrl',
    label: 'Package Registry',
    description:
      'The npm registry a package installed while the host runs comes from (Admin → Packages, `neuralis package install`): an https URL, or http on this machine only, with no user name or password in it. A private registry\'s token is never read from here; a scope this machine has installed from a private registry is refused at runtime. Applies to the next install.',
    type: 'string',
    default: 'https://registry.npmjs.org/',
    category: 'runtime',
  },
  {
    key: 'packageInstallTimeoutMs',
    label: 'Package Install Timeout (ms)',
    description:
      'How long one npm run of a package install, update or fetch may take before it is stopped and the install is undone. Applies to the next install.',
    type: 'number',
    default: 900_000,
    min: 30_000,
    max: 1_800_000,
    category: 'runtime',
  },
  {
    key: 'packageUploadMaxMb',
    label: 'Package Upload Max (MB)',
    description:
      'The largest package tarball (.tgz) a person may upload to install. Applies to the next upload.',
    type: 'number',
    default: 25,
    min: 1,
    max: 200,
    category: 'runtime',
  },
  {
    key: 'passwordHashWorkers',
    label: 'Password Hash Workers',
    description:
      'Most worker threads that hash and check passwords (login, password change, invites) beside the request thread — never more than the CPU cores minus one. Each holds ~10 MB while alive. Applies to the next login.',
    type: 'number',
    default: 2,
    min: 1,
    max: 16,
    category: 'runtime',
  },
  {
    key: 'passwordHashQueueMax',
    label: 'Password Hash Queue',
    description:
      'Most password checks waiting for a worker; one more is refused (the login fails, nothing is counted against the account). Applies to the next login.',
    type: 'number',
    default: 32,
    min: 1,
    max: 1_024,
    category: 'runtime',
  },
  {
    key: 'passwordHashTimeoutMs',
    label: 'Password Hash Timeout (ms)',
    description:
      'How long one password check may take, waiting included; past it the login is refused and the worker replaced. Applies to the next login.',
    type: 'number',
    default: 15_000,
    min: 1_000,
    max: 120_000,
    category: 'runtime',
  },
  {
    key: 'passwordHashWorkerIdleMs',
    label: 'Password Hash Worker Idle (ms)',
    description:
      'An idle password worker exits after this long; the next login starts a new one (~50 ms). Applies to the next login.',
    type: 'number',
    default: 60_000,
    min: 1_000,
    max: 3_600_000,
    category: 'runtime',
  },
];

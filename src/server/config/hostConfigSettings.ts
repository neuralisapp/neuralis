import type { PackageConfigSetting } from '@neuralis/package-system/contracts';

/**
 * The HOST's own platform-config declarations — registered through the SAME
 * `registerSettings` mechanism every first-party package uses (declarer
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
      'Keepalive comment-frame interval on the multiplexed /api/events SSE hub and the project presence stream; keeps HTTP/1.1 intermediaries and the browser from idling out the connection. Applies to newly opened connections.',
    type: 'number',
    default: 25_000,
    min: 5_000,
    max: 55_000,
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
    key: 'dataCheckpointKeep',
    label: 'Data Checkpoints Kept',
    description:
      'How many control-plane checkpoints to keep under <NEURALIS_HOME>/checkpoints/. One is taken automatically, at boot, before a stored data format is raised to what a newer build writes; restoring one (`pnpm neuralis:checkpoint restore <id>`, app stopped) is how an operator goes back to the previous build. Older ones are pruned when a new one is taken. Read at boot.',
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
];

export const DATA_DIRECTORY_DOCS: Record<string, string> = {
  'README.md': `# NEURALIS_HOME/app

This directory is the platform data root for \`neuralis\` community mode.
The runtime resolves it from \`NEURALIS_HOME\` (default: ~/.neuralis).

## Architecture

Two-zone data isolation:

\`\`\`
~/.neuralis/                              # NEURALIS_HOME
├── app/                                  # AGENT CANNOT ACCESS (this dir)
│   ├── users/                            # UserStore (passwordHash!)
│   ├── projects/                         # ProjectStore (membership)
│   ├── packages/                         # Legacy (migrated to projects/<id>/_packages/)
│   ├── config/                           # mcp-api-key.txt, global settings
│   ├── data/                             # first-party package PLATFORM data: <package>/ (globalDir), incl. its logs/
│   └── logs/                             # host-owned JSONL: audit.jsonl, routes.jsonl
│
└── projects/                             # AGENT CAN ACCESS (project-scoped)
    └── <projectId>/
        ├── agent-core/                   # Per-agent isolation
        │   └── <agentId>/               # Each agent's isolated directory
        │       ├── <agentId>.json       # Agent config
        │       ├── conversations/       # Per-agent conversations
        │       │   └── <convId>/        # Conversation messages (JSONL)
        │       ├── workflows/           # Workflow entries, state, runs (per workflow)
        │       └── usage/               # Per-agent usage tracking
        │           ├── events.jsonl     # Usage event log
        │           └── daily/           # Daily quota counters
        │               └── YYYY-MM-DD.json
        ├── brain-core/                   # sources.json, filesystem bridge data
        ├── terminal/                     # Terminal sessions
        ├── _packages/                    # Installed/authored packages (project-scoped)
        └── workspace/                    # fs_* tool target (data root)
\`\`\`

## Directory status

| Path | Zone | Status | Notes |
| --- | --- | --- | --- |
| \`app/users/\` | app | active | file-based user records (passwordHash) |
| \`app/projects/\` | app | active | file-based project records |
| \`app/packages/\` | app | legacy | migrated to projects/<id>/_packages/ |
| \`app/config/\` | app | active | mcp-api-key.txt, global settings |
| \`app/logs/\` | app | active-generated | host-owned JSONL — \`audit.jsonl\` (security/admin events) and \`routes.jsonl\` (one line per package-route dispatch). Both platform-global; both read through the admin Logs tab behind \`platform.audit\`. Per-PACKAGE logs live in the sibling \`app/data/<package>/logs/\` (first-party) or under \`projects/<id>/data/_installed/<slug>/logs/\` (project-installed), governed by \`packageLogLevel\`. |
| \`app/data/\` | app | active | first-party package PLATFORM data — \`<package>/\` is that package's \`globalDir\` (process-global stores + its \`logs/\`); read through the admin Logs tab behind \`platform.audit\`, never \`data://\`-addressable |
| \`projects/<id>/\` | projects | active | per-project package data + workspace |

## Editing contract

App-zone: avoid manual edits unless doing maintenance or migration.
Projects-zone: managed by packages at runtime (agent-core, brain-core, etc.).
`,
  'config/README.md': `# config

Status: active.

This folder stores global configuration for the community host.
Current contents:
- \`mcp-api-key.txt\` — auto-generated API key for MCP HTTP clients

Rules:
- Do not treat this folder as workspace memory.
- Prefer env vars or API-driven config over manual edits.
`,
  'packages/README.md': `# packages

Status: legacy — migrated to per-project \`_packages/\` directories.

Packages are now stored at \`projects/<projectId>/_packages/<slug>/\`.
This directory exists only for migration purposes. After migration,
\`catalog.json\` is renamed to \`catalog.json.migrated\`.
`,
  'logs/README.md': `# logs

Status: active-generated.

This folder holds the HOST's own JSONL logs — the ones that belong to no package:

- \`audit.jsonl\` — security and admin events (\`AuditStore\`). Appended, never
  deleted: past \`auditLogMaxBytes\` it is renamed to \`audit.jsonl.1\` and
  every older generation moves up one index and stays.
- \`routes.jsonl\` — one structured line per package-route dispatch: pattern,
  method, status, duration, caller, and why a request was refused. Never a
  request path. At the default \`warn\` level it holds refusals, faults and
  dispatches slower than \`routeSlowMs\` (marked \`slow: true\`); the same
  lines also reach the Docker console unless \`routeConsoleLogLevel\` sets
  that console its own level. Level/rotation: the \`routeLogLevel\` /
  \`routeLogMaxBytes\` / \`routeLogMaxFiles\` platform keys (default \`warn\`,
  25 MB x 5). The level applies live, with no restart.

Per-PACKAGE logs are NOT here either: a first-party package's own logs live in
the sibling \`data/<package>/logs/\` (its platform home), a project-installed
package's under \`projects/<projectId>/data/_installed/<slug>/logs/\`; both are
governed by the separate \`packageLogLevel\` key (per-package exceptions:
\`packageLogLevelOverrides\`). Neither of these is the DOCKER log: that is container
stdout, governed by \`logLevel\`, and it is lost on restart.

Rules:
- Do not use this folder as workspace memory.
- Do not hand-edit logs except for targeted maintenance.
- Rotation is automatic (size + age); the retention the defaults buy is stated
  in each key's description in the admin Config tab.
`,
  'projects/README.md': `# projects

Status: active runtime storage.

This folder contains one JSON file per project record.
Files are managed by \`ProjectStore\`.

Rules:
- Prefer the app/API for normal changes.
- Manual edits are for inspection, migration, or careful repair work only.
`,
  'users/README.md': `# users

Status: active runtime storage.

This folder contains one JSON file per user record.
Files are managed by \`UserStore\`.

Rules:
- Prefer the auth/API flow for normal changes.
- Manual edits can break credentials or identity data.
- Use direct edits only for controlled admin or migration tasks.
`,
};

/** Directories to create under appRoot (~/.neuralis/app/) */
export const APP_DIRECTORIES: readonly string[] = [
  'users',
  'projects',
  'config',
  'packages',
  'data',
  'logs',
] as const;

/** Directories to create under projectsRoot (~/.neuralis/projects/) */
export const PROJECTS_DIRECTORIES: readonly string[] = [
  // The root itself is enough — per-project dirs are created by projectInit
] as const;

/** Directories that get .gitkeep files (under appRoot) */
export const APP_GITKEEP_DIRECTORIES = new Set<string>([
  'users',
  'projects',
  'config',
  'packages',
  'logs',
]);

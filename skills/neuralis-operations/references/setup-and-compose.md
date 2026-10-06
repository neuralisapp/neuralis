# Setup and the compose file

## The four configuration layers

They are separate on purpose, and mixing them is the usual source of "I changed it and
nothing happened".

| Layer | Lives in | Changed by | Applies |
|---|---|---|---|
| Boot-critical environment | `.env` | `neuralis:setup` | at container start |
| Machine topology | `docker-compose.yml` | `neuralis:setup [--compose-only]` | at `up -d` |
| Machine-local mounts | `docker-compose.override.yml` | `neuralis:mount` | at `up -d` |
| Runtime settings | `~/.neuralis/app/config/platform.json` | the admin UI, live; `neuralis:setup` merges missing keys | immediately |

Long-lived secrets belong to none of these: they live encrypted in the credential store
under `~/.neuralis/app/credentials/`. Anything placed in a container's environment is
readable with `docker inspect`, which is why provider API keys are never compose values.

## What `neuralis:setup` writes

Run it **before** the first `docker compose up`. If Docker creates the data directories
first they end up owned by root, and the container — which runs as your user — cannot
write them. The wizard:

- creates `~/.neuralis/app/` and `~/.neuralis/projects/` with correct ownership;
- writes `.env`, including a generated `NEXTAUTH_SECRET`;
- seeds the first owner account and project **directly to disk**, not through the API;
- probes the environment (Docker, Qdrant, Ollama, platform) and offers matching choices;
  the first beta bundles Ubuntu XFCE only, with optional background pull of the
  actual Neuralis derivative image; kickoff does not mean the download finished.
  Existing custom `machineImage` settings remain operator-controlled;
- generates `docker-compose.yml` for this machine.

## Custom LLM endpoints

The wizard's endpoint step registers chat-model sources into `platform.json`'s
`localLLMs` list. It auto-probes the standard local ports (Ollama, LM Studio,
vLLM, llama.cpp, LocalAI) and then offers a manual add loop, which is where a
REMOTE endpoint goes: the same list holds a gateway (OpenRouter, Together,
Groq, an Azure-OpenAI proxy, a company gateway) as happily as an Ollama on the
same box. The manual branch asks two things beyond the URL and the framing:

- **Authentication.** `None`, or a bearer **API key**. A key is written to the
  credential store as `llm.endpoint.<id>` at GLOBAL scope, in the same
  encrypted-file format as every other credential — never into `.env` (a
  compose environment value is readable with `docker inspect`) and never into
  `platform.json`, which is an admin-visible plaintext file. Global scope is
  also what makes the endpoint's model list discoverable: discovery runs once
  per endpoint for the whole instance, so a member- or project-scope key is
  used for streaming only.
- **Address class.** *Private* (your own machine or network) or *public*. A
  public endpoint's address is validated on every connection, with the
  connection pinned to the validated address; saving one through the admin form
  validates it there too. **The wizard itself validates nothing** — it is a
  first-run CLI that executes before any package is built, so it cannot reach
  that check. It only INFERS a default from the URL's shape (a loopback or
  RFC-1918 address pre-selects *private*); the admin form defaults a new entry
  to *public* unconditionally. *Private* is an explicit operator exemption from
  the check — which is exactly what pointing at `localhost` is. Endpoints that
  predate the field stay private.

Everything the wizard writes is editable afterwards in the admin **Credentials**
tab under *Custom endpoints*, which also adds a static model list and pricing.
Two fields are NOT on that form — per-model overrides and extra non-secret
headers — and stay raw-JSON edits on the Config tab. Pricing matters for more
than the invoice: a KEYED or PUBLIC endpoint with no price records `unpriced`
usage, which dollar-denominated spend limits cannot bound. An unauthenticated
endpoint on a private address records `local` instead — your own hardware, where
`$0` is the truth.

## Custom embedding endpoints

The Vector step's *Custom endpoint* row registers one OpenAI-compatible
`/v1/embeddings` server into `platform.json`'s `embeddingEndpoints` list: label,
base URL (the client appends the path), the model name and the vector
dimension it returns, then the same two questions as above — its key goes to
`embedding.endpoint.<id>` at GLOBAL scope, and the address class decides the
connection check. Unlike an LLM endpoint, an embedding entry has no defaults for
either answer: both are always stated. The entry is checked by the same parser
the admin write route uses before it is seeded (the address itself is checked
at connect time, and on save in the admin form). The active model becomes
`endpoint:<id>:<model>`. Afterwards the list is edited in the admin Vector
section; the generic Config PATCH refuses both endpoint lists.

## Re-running setup on an existing install

A re-run is a maintenance action, not a reinstall, and it is the supported way to
change an infrastructure answer. What it preserves, and why each one matters:

| Preserved | Why |
|---|---|
| Everything in `platform.json` | Those are admin decisions made through the UI. Only missing keys are added; package-declared tunables (agent step cap, temperature, project cap) are not seeded at all — the platform resolves those from the declaration, and seeding one freezes a value the package owns. |
| `NEXTAUTH_SECRET` | Rotating it invalidates every session — everyone is logged out with no warning. Delete `.env` to rotate deliberately. |
| `QDRANT_API_KEY` | Every Qdrant client authenticates with it and the compose hands the SAME value to the Qdrant server — re-minting it over a live value locks the server out until the next recreate. Minted only in docker/binary modes; in external mode the wizard asks (empty = unauthenticated server) and preserves what you typed. Delete the line to rotate deliberately, then recreate the stack. |
| The MCP API key | Every configured MCP client authenticates with it. |
| Existing source configs | They carry edits to permissions, uri-policy rows and sync excludes. Only a missing one is seeded. |
| Users and projects | The wizard has never deleted either. |
| `NEURALIS_COMPOSE_PROJECT` | The Compose project name prefixes the named volumes, the networks and every container name — renaming it orphans `qdrant-data`. |
| `NEURALIS_IMAGE_TAG` | The release an install that runs the published image is on; the compose file pins exactly that tag. A fresh install records the version it was set up from; an update moves it (`neuralis:update`, or the hand edit below), and re-deriving it would step the install back. |
| `<NEURALIS_HOME>/qdrant-version.json` | The Qdrant version the storage is on; the compose file renders exactly it. Only `pnpm neuralis:qdrant-upgrade` advances it. A missing one is recorded from what setup detects (the running server, else the compose tag or the installed binary) — or, for an install with no storage yet, the shipped version. |

The wizard seeds a new project's `packages` and `brain` sources only. Its
`data` source is created by the platform on the first boot, with the same
defaults a project created from the app gets — including the usage counters
left out of the search index. A missing `data` source is re-created on every
boot; an existing one is never touched.

Three things a re-run refuses rather than guesses:

- **A project it cannot name.** A re-run maintains a project that already exists:
  answer with its name, or with its id when two projects share a name. It keeps
  that project's id (a project renamed in the app keeps its id) and its recorded
  owner. An answer no active project carries, a record with no owner, or users
  with no active project at all are refused — answering with another name used to
  write a whole directory tree and its source configs under a project record that
  was never created. Create further projects from the app.
- **A malformed public origin.** It is the one answer with no safe default, and a
  wrong value breaks the login round-trip for everyone not on the machine itself.
- **A Qdrant it cannot or must not render.** Storage whose version it cannot read, or a
  recorded version more than one minor behind the shipped one (docker and binary
  mode): it writes no compose file and no binary, and names `pnpm neuralis:qdrant-upgrade`.
  An existing install meets this at the first `--compose-only` after the update. A FULL
  setup does so only with the stack stopped: while Qdrant answers, it takes the
  external-Qdrant branch instead.

Setup also *reports* source-config directories with no matching project record —
residue from the old name-mismatch behaviour. It never deletes them; project
removal is a guarded operation that belongs to the app.

## The compose file is generated, not shipped

It carries concrete machine-specific values — user and group IDs, the Docker socket
group, ports, the Qdrant URL for the mode you chose — and a version-stamp header. It is
**not** hand-edited: regenerate with `pnpm neuralis:setup --compose-only`. The two
interpolations left in it are `NEXTAUTH_SECRET` and `QDRANT_API_KEY`, both from `.env`
(the compose file never carries a secret). In docker mode `--compose-only` refuses
loudly — writing nothing — when `.env` has no `QDRANT_API_KEY`: the emitted
`${QDRANT_API_KEY:?}` interpolation would otherwise make every compose command die,
`down` included. The refusal names the fix (re-run the full setup, or add the line).

An install that runs the published image gets `image: neuralisapp/neuralis:<tag>` with the
`.env` `NEURALIS_IMAGE_TAG` value — never a moving tag, never a default: without the line
`--compose-only` refuses the same way, writing nothing. To move to another release (or back
to the previous one) by hand — the only way on a pull-only install, which has no
`neuralis:update` — change that line, then `pnpm neuralis:setup --compose-only` (or the
in-container form below) and `docker compose up -d -V`. An install that builds its own image
has no such line; its `build:` block is described next.

On an install that builds its own image, the `neuralis` service's `build:` block is
derived here too: one named context per registered local package (a folder or tarball
that no longer exists stops the regeneration, named), the `<NEURALIS_HOME>/build/`
folder (the kept build lock and the private-scope record, which this step feeds), and —
when `.env` names `NEURALIS_BUILD_NPMRC` — that file as a build secret (its PATH only;
a default `registry=` line or no scope line is refused). A pulled-image install builds
nothing, so setup names a registered local package such an image cannot carry.

Up to three services are emitted:

- **`neuralis`** — the host: UI, API, in-process package runtime, embedded MCP HTTP
  service. Publishes `3100` (app), `3101` (MCP + package companion surfaces), `3102`
  (the MCP Apps sandbox origin), and `127.0.0.1:1455` — the Codex login callback, host
  loopback only — ONLY when `.env` says `NEURALIS_CODEX_LOOPBACK=on` (default `off`;
  the full setup asks it on Docker, defaulting to the current value — or edit `.env`,
  then `--compose-only` + `up -d`). Opted in, Docker holds the host's 1455
  while the stack runs: a native `codex login` on that host cannot use it, and `up`
  fails while something else holds it. Off, the Finish callback URL field is the path.
- **`qdrant`** — emitted only if you chose the compose-managed vector database. Bound to
  loopback; data in the `qdrant-data` named volume, snapshots in `qdrant-snapshots`. It requires its API key
  (`QDRANT__SERVICE__API_KEY`) on every request and sits on its OWN compose network:
  the app spans both networks, while every child container (webtop desktops, MCP
  sidecars, ollama) lives on the default one and cannot reach the vector store at all —
  the app-service env pins `NEURALIS_MACHINE_SHARED_NETWORK=<project>_default` so that
  placement is a contract, not detection luck.
- **`ollama`** — emitted only if you chose a compose-managed local model runtime.

**The Qdrant dashboard switch:** the static web UI at `127.0.0.1:6333/dashboard` is ON
by default. To turn it off, set `QDRANT_DASHBOARD=off` in `.env`, then
`pnpm neuralis:setup --compose-only` and `docker compose up -d` — the regen emits
`QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false` to the qdrant service (the API is
unaffected). Setting it back to `on` (or removing the line) and repeating the two
commands restores it. A FULL setup re-run rewrites the line to `on`.

**Qdrant telemetry is off** in every generated compose and on every native (binary-mode)
start (`QDRANT__TELEMETRY_DISABLED=true` — on-prem, no phone-home). `pnpm neuralis:rebuild`
never regenerates the compose file, so an install generated before this setting keeps
reporting until `pnpm neuralis:setup --compose-only` and then `docker compose up -d qdrant`.
That recreate stops any optimizer run in progress (it starts over), so run it when
`GET /collections/<collection>/optimizations` lists nothing under `running`. Afterwards the
qdrant log no longer prints `Telemetry reporting enabled`.

**Migrating an existing install to the authenticated Qdrant:** re-run
`pnpm neuralis:setup` (it mints and preserves the key), or add a
`QDRANT_API_KEY=<random>` line to `.env` by hand, then
`pnpm neuralis:setup --compose-only` and `docker compose up -d`. One recreate carries
both containers. A mistyped key does not kill the boot: the app falls back to in-memory
vectors and logs `vector.qdrant.unauthorized` until the key matches. A NATIVE
(binary-mode) Qdrant that is already running keeps accepting keyless requests until it
is stopped and started again — the key rides its spawn environment.

Two constants in the generated file are worth knowing before you change timeouts
elsewhere: the healthcheck allows a 50-second start period (the bootstrap genuinely
takes that long, so do not judge health for about a minute), and the stop grace period
is 40 seconds — deliberately longer than the in-flight stream drain, so a graceful stop
finishes persisting turns before the container is killed.

## Base versus override — opposite lifecycles

`docker-compose.yml` is **disposable**: regenerating it is normal and expected on
update. `docker-compose.override.yml` is **durable**: it holds this machine's mounts and
survives every regeneration. That is the whole reason mounts are not written into the
base file.

Compose merges them automatically **only** when invoked from the host folder with no
`-f` flag. Any other invocation silently skips the override, and the stack comes up
healthy with none of its mounts. See `rebuild-and-sync.md`.

To see what compose actually resolved to, ask it rather than reading either file:

```bash
docker compose config
```

## Running the wizard inside a container

The wizard can run in a one-shot container and write onto a host bind, which is
how a pull-only install (no source tree) configures itself:

```bash
docker run -it --rm \
  -v ~/.neuralis:/.neuralis \
  -v "$PWD":/out \
  -p 1455:1455 \
  neuralisapp/neuralis:<version> \
  node --import tsx scripts/setup.mts --output /out \
    --uid "$(id -u)" --gid "$(id -g)" --docker-gid "$(stat -c %g /var/run/docker.sock)"
```

`<version>` is the release you install; on a fresh install the wizard records the version
baked into that image as `NEURALIS_IMAGE_TAG`. Two things the container cannot work out for
itself, hence the flags: it runs as its own user (not yours), and the docker socket's group is invisible through the
bind. Those values are baked into the generated compose — a wrong one produces a
stack that cannot write its own data directory. The published port is for the
OAuth loopback callback, if you sign in to a provider during setup.

## Installing without Docker

The same host runs natively on Node 22.22.2 or newer (26 recommended): from the host folder, run `npm run neuralis:setup`, `npm run build`, then `npm run start`. Setup writes `.env` beside the host on this plane, where Next loads it; inside a pulled container it uses the persistent `NEURALIS_HOME`, and `--output` overrides either location. You
supply a Qdrant instance (`QDRANT_URL`, default `http://localhost:6333`); the setup
wizard can download and start one for you. Without a reachable Qdrant the host still
starts in a degraded in-memory vector mode and re-probes in the background.


## Boot environment

| Var | Purpose | Notes |
|---|---|---|
| `NEXTAUTH_SECRET` | NextAuth session encryption | Required. Generated by `pnpm neuralis:setup`. |
| `NEXTAUTH_URL` | Public app URL | Defaults to `http://localhost:3100` — a dev convenience, **not** a working remote fallback. Must name the origin users actually reach (LAN IP / hostname / domain + port) on any non-localhost deployment, together with `APP_URL`; authentication and OAuth callbacks resolve against it server-side. The login page navigates to a target validated against the browser's own origin (`src/app/auth/callbackUrl.ts`), so a stale value no longer throws users at localhost after login — but every server-issued callback still uses this value. |
| `NEURALIS_APP_PORT` | Next.js port | Defaults to `3100`. |
| `MCP_HTTP_PORT` | External MCP service port | Defaults to `3101`. |
| `OAUTH_JWT_KEY_ID` | `kid` header of the access tokens the `:3101` OAuth server signs | Optional, default `neuralis-1`. Read by agent-core's MCP companion at mount. Change it only together with a key rotation, so clients that cache the JWKS re-fetch it. |
| `OAUTH_ACCESS_TOKEN_TTL` | Lifetime (seconds) of a `:3101` OAuth access token | Optional, default `3600`. Deploy topology, not a platform-config key: a config write must never be able to widen a token's lifetime. Refresh and auth-code lifetimes are code constants. |
| `KEEP_ALIVE_TIMEOUT` | :3100 server keep-alive timeout (ms) | Default `55000` (baked in `Dockerfile`; the prod `next start` script takes it via the `--keepAliveTimeout` flag in `package.json` — `next dev` does not accept the flag). Raised from Node's 5s default to kill the reused-keep-alive-socket `ERR_CONNECTION_RESET` race; stays under the 60s `headersTimeout`. Preserve SSE and WebSocket transport through the reverse proxy. |
| `NEURALIS_HOME` | Data root (in-container: `/.neuralis`) | Setup auto-detects per platform. |
| `NEURALIS_HOST_HOME` | Host-pair root for the default `data`/`packages` project sources | Required in Docker so their vector payloads carry host paths, not container paths. Custom mounts use the `NEURALIS_MOUNT_*` pair instead. |
| `NEURALIS_MOUNT_<slug>` / `NEURALIS_MOUNT_HOST_<SLUG>` | Container path + host-pair root for a `pnpm neuralis:mount` bind | Written to `docker-compose.override.yml`. `discoverRuntimeStack` lists them; `LocalDiskConnector` derives a source's `hostRoot` from the matching pair when the config omits one. |
| `NEURALIS_HOST_BROKER_SECRET_FILE` | Container path of the bind-mounted host-broker secret | Emitted into the generated compose only when the operator has provisioned the broker. The secret is read from a FILE, never from platform config (config is writable behind the grantable `platform.config` feature). The broker process itself reads `NEURALIS_HOST_BROKER_{SOCKET,LISTEN,SECRET_FILE,CEILING_FILE,SCRATCH_ROOT,SANDBOXER,ORIGIN_ALLOW}` on the **host**, set by its unit — `pnpm neuralis:host-broker init` prints them. |
| `QDRANT_URL` | Vector DB endpoint | `http://qdrant:6333` in Docker, `http://localhost:6333` native. |
| `QDRANT_API_KEY` | The Qdrant API key — every Qdrant request must carry it | **Setup-generated, mode-conditionally**: minted (preserve-if-exists, NEXTAUTH_SECRET family) in `docker` and `binary` modes, ASKED FOR in `external` mode (never minted — the server belongs to someone else; empty means unauthenticated), absent in `skip`. Boot-critical **infra env, not a credential**: the Qdrant client is constructed synchronously at boot, before the encrypted store can be decrypted. In docker mode the compose file hands it to the server via `${QDRANT_API_KEY:?}` interpolation (`QDRANT__SERVICE__API_KEY`); in binary mode the setup spawn env carries it. Consumed by brain-core's `QdrantClient`, by `@neuralis/admin`'s REST probes, by `pnpm reset:vector` (`api-key` header — `src/server/config/qdrantFetch.ts` is the host-side helper) and by `pnpm neuralis:qdrant-upgrade` (the header in-process on the loopback port; a hop container gets it through a 0600 env-file, never argv). The setup-time reachability probe deliberately does NOT send it: it shares one header-free `httpGet` with the Ollama probe, so a key there would reach a different service, and it only calls `/healthz` and `/`, which Qdrant's auth whitelist leaves unauthenticated. Stripped from every agent shell (`/^QDRANT_/` blocklist row) and from helper-child spawns (authored `{ PATH }` env). Surfaced read-only on the Config tab as `(set)` / `(unset)`, never as a value. |
| `QDRANT_MODE` | How Qdrant is provisioned (`docker` / `binary` / `external` / `skip`) | Written by setup; read back by `pnpm neuralis:setup --compose-only` so the compose regen emits the right qdrant service / `QDRANT_URL` shape without re-asking. |
| `NEURALIS_CODEX_LOOPBACK` | Codex sign-in loopback publish on the Docker shape (`on` / `off`, default `off`) | Operator opt-in: the full setup asks it on the Docker shape (default = the current `.env` value, `off` on a fresh install); editing `.env` and running `pnpm neuralis:setup --compose-only` works too. `on` makes the compose regen publish `127.0.0.1:1455:1455` and set the container's bind to `0.0.0.0`; Docker then holds the host's 1455 while the stack runs. The compose always sets it explicitly in the service environment, so an `.env` flipped without the regen changes nothing. |
| `NEURALIS_TRUSTED_PROXIES` | Reverse proxies (addresses / CIDR blocks, comma- or space-separated) whose `X-Forwarded-For` the host believes | **Default empty: no forwarding header is believed** — the connecting socket is the client. Written by the full setup (asked, default = the current `.env` value) and read at boot. One invalid entry voids the whole list (warned). Topology, not a tunable — never a platform-config key. See "Sessions and request identity". |
| `QDRANT_DASHBOARD` | Qdrant web dashboard switch (`on` / `off`, default `on`) | Operator switch for the static dashboard SPA at `127.0.0.1:6333/dashboard`. `off` makes the compose regen emit `QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false` to the qdrant service (the API is unaffected). Flow: edit `.env` → `pnpm neuralis:setup --compose-only` → `docker compose up -d`. Not a secret; a full setup re-run rewrites the line to `on`. Bounded exposure either way: the dashboard is a static SPA, its API calls 401 without the key, and after the network isolation it is reachable only from the app container and the host loopback. |
| `OLLAMA_URL` | Bootstrap default for embedding-Ollama URL | Read once by setup to seed `platform.json`. Runtime embedding URL lives in platform config; this env is only used at first-boot. |
| `BRAIN_INFRA_MODE` | In-process brain (`local`) vs external mode | Default `local`. |
| `NEURALIS_BUILTINS` | Comma-separated FULL package-id list override (e.g. `@neuralis/agent-core,@neuralis/brain-core`) | Optional. Omit for full builtin set. |
| ~~`NEURALIS_PKG_LINKS`~~ (+ its `NODE_PATH` fallback) | — | RETIRED: a `--pkg` mount binds the folder onto `node_modules/<name>`, so nothing reads a link list; `pnpm neuralis:mount` rewrites an override that still carries one. |
| `NEURALIS_BUILD_NPMRC` | Path to the operator's `.npmrc` for a private registry (scope lines only: `@scope:registry=<url>` + its `_authToken` line, never a default `registry=`) | Hand-written in `.env`, carried by setup, never asked. The compose regen passes the FILE to the image build as a BuildKit secret (never a layer, build arg or `compose config` value) and fails, naming the problem, on a missing file, a default `registry=` line or no scope line. `pnpm neuralis:pkg add` refuses a package whose dependency is in a scope known to be private (`<NEURALIS_HOME>/build/private-scopes.json`, a lock, a manifest) with no line here. |
| `NEURALIS_DOCKER_OVERLAY` | Audit marker for `--with-docker` overlay capability | `1` when the LLM shell can drive the host Docker daemon. |
| `NEURALIS_DOCKER` | "We are running inside Docker" flag | `true` in the generated compose env; setup also reads it. `NEXT_PUBLIC_NEURALIS_DOCKER` is **not** a runtime env: it is inlined into the client bundle at `next build` (the Dockerfile builder stage sets it `true` — images are Docker by definition). |
| `LOCAL_UID`, `LOCAL_GID`, `DOCKER_GID` | Container uid/gid + docker-group GID | Written by setup; baked concretely into the generated compose (`user:` / `group_add:`). |
| `NEURALIS_COMPOSE_PROJECT` | Docker Compose project name for this install | Written by setup and PRESERVED across re-runs; read back by `--compose-only`. It prefixes the named volumes, the network and every container name, so changing it on an existing install orphans `qdrant-data`. Defaults to `neuralis`; setup derives a distinct name only when Docker reports another project already claiming it. |
| `NEURALIS_VERSION`, `NEURALIS_REVISION` | What this deployment was built from | Baked into the image from build args, and surfaced in the AUTHENTICATED admin environment table. Absent on a source checkout, where the tree is the answer. The anonymous health endpoint deliberately carries no version. |
| `MAX_AGENT_STEPS` | Env fallback for the per-stream step cap | The setting lives in `platform.json` as `maxAgentSteps` (editable in Admin → Config; the DECLARED default is 300 — agent-core's `configSettings[]`); a stored value wins over this env. Setup no longer seeds it: a seeded value would freeze a number the package owns, and the 40 it used to write acted as a hard ceiling. |
| `NEURALIS_STREAM_TIMING` | Env fallback for the `streamTimingEnabled` platform setting (`1` or `true`) | The toggle lives in Admin → Config → Debug ("Stream Timing"); a stored value wins. When on, one `TEMP_TIMING_SUMMARY` block per stream (setup-phase deltas + per-step cache hit%). Resolved per stream — no restart needed. |
| Machine-core knobs (`NEURALIS_MACHINE_*`) | Webtop image, variant, idle, recording TTL, key-combos + infra (socket, ports, network, seccomp) | The TUNABLE set (image, variant, idle, recording TTL, key-combo exceptions) is admin-editable platform config since Inc 4 (env = fallback); the docker socket path, CDP/sidecar ports, shared network and seccomp stay env-only infra. |
| ~~Channel webhook secrets (`TELEGRAM_*`, `WHATSAPP_*`)~~ | — | channel secrets live exclusively in the `CredentialStore` at the connection's owning scope (`telegram.*` / `whatsapp.*` ids, per-connection derived); never env. |

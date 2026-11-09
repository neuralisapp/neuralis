# Setup and the compose file

## The four configuration layers

They are separate on purpose, and mixing them is the usual source of "I changed it and
nothing happened".

| Layer | Lives in | Changed by | Applies |
|---|---|---|---|
| Boot-critical environment | `.env` | `neuralis setup` | at container start |
| Machine topology | `docker-compose.yml` | `neuralis:setup [--compose-only]` | at `up -d` |
| Machine-local mounts | `docker-compose.override.yml` | `neuralis mount` | at `up -d` |
| Runtime settings | `~/.neuralis/app/config/platform.json` | the admin UI, live; `neuralis setup` merges missing keys | immediately |

Long-lived secrets belong to none of these: they live encrypted in the credential store
under `~/.neuralis/app/credentials/`, and the keys needed before that store opens — its master
key and salt, the session secret — are 0400 files in `~/.neuralis/app/config/`. Anything placed in a container's environment is
readable with `docker inspect`, which is why provider API keys are never compose values.

## What `neuralis setup` writes

Run it **before** the first `docker compose up`. If Docker creates the data directories
first they end up owned by root, and the container — which runs as your user — cannot
write them. It writes `~/.neuralis/{app,projects}`,
the session secret (`~/.neuralis/app/config/session-secret.key`, 0400 — in the data home,
never in `.env`), the `.env` (in docker/binary Qdrant modes with a minted
`QDRANT_API_KEY` the server then enforces on every request), the first owner account
and project, a new home's data-format ledger at the current versions (it has nothing to raise, so a
first boot that fails part-way leaves no pending `upgrade`), and **generates `docker-compose.yml`** for this machine. Of the core packages
(admin, agent-core, brain-core always load) only `@neuralis/machine-core` — the virtual desktop and
the Docker substrate of sidecar MCP servers — can be left off: off without Docker, `--advanced` asks,
`--no-desktop` forces it. Off is `disabledBuiltinPackages: ["@neuralis/machine-core"]` in the data
home's platform config (Admin → Config, on restart; every install on that home): installed, not
loaded, its desktop sources kept but orphaned. Any other name there is ignored and logged.

The first owner account and project are seeded **directly to disk**, not through the API. The wizard
probes the environment (Docker, Qdrant, Ollama, platform) and offers matching choices;
the first beta bundles Ubuntu XFCE only, with optional background pull of the
actual Neuralis derivative image; kickoff does not mean the download finished.
Existing custom `machineImage` settings remain operator-controlled.

## What setup asks

**What it asks:** the owner account (the password typed twice), the public origin, a free port for
a busy one, Docker or native on a checkout with Docker, which Qdrant when one it did not set up answers, and
trusted proxies only for a non-loopback origin; a re-run keeps every user and asks no owner, but asks
which project to maintain and whether to overwrite the `.env` and compose file it wrote. A checkout
with no reachable Docker is asked ONE question first, before anything is written — the vector store
and the virtual desktop both need Docker: [1] install Docker first (Enter; prints the install link
and exits, writing nothing), [2] continue natively (the pinned Qdrant binary, downloaded and
started, no virtual desktop; a platform with no published binary or a failed download is named and
runs in-memory), [3] continue in-memory only; either answer runs natively. Nothing else picks an install. Every other question
takes its default answer — no provider key, no OpenAI sign-in, the compose-managed Qdrant, a
detected Ollama or local LLM server added, the recommended embedding model as the target with
`embeddingEnabled: false`, the desktop image pulled in the background, the project `My Workspace`,
no ChatGPT-callback publish — and the summary's "Next, in the app" names where each is set: Admin →
Credentials (keys, Sign in with ChatGPT), Admin → Vector (embedding), Credentials → Custom
endpoints. `setup --advanced` asks every question (an external Qdrant URL included); `--help`
lists the flags. An npm folder and a Docker clone then offer "Start Neuralis now?"
(`docker compose up -d` in the folder). Setup in the image offers no start and starts no pull — a
pull there dies with the one-shot container — and names `docker pull <the desktop image>` after
the next steps; the installer does both on the host.

One answer has no safe default: the **public origin**. It is what `NEXTAUTH_URL` and
`APP_URL` become (`.env` is their one source; compose reads it), and `MCP_BASE_URL` and
the sandbox derive from it on their ports — and the wizard cannot detect how users will
reach the deployment. Leave it at localhost only for a single-machine install. A re-run
keeps an `MCP_BASE_URL` / `NEURALIS_MCP_SANDBOX_ORIGIN` the operator declared and names
it in the summary; over https it warns that the proxy must serve the derived MCP and
sandbox ports with TLS too, or that `.env` declares names of their own. Sign-in, consent
and the terminal are on the app address; the MCP address serves the CLI, devices, MCP
clients and the desktop stream. Every shape (own names, one hostname, LAN):
§Boot environment, below.

With `--advanced` the Vector step asks for the embedding model and **its own key** — `embedding.openai`,
`embedding.gemini`, `embedding.qwen`, `embedding.voyage`, or `embedding.endpoint.<id>` for a
custom OpenAI-compatible `/v1/embeddings` server. It is not the chat key: embedding spend is
counted and capped on its own. Leaving the key empty, picking **No embedding model**, or
skipping Qdrant seeds `embeddingEnabled: false`: indexing, text and field search and
source-discovered skills work, no provider is called, and the first boot writes a
metadata-only lock. To add semantic search later, set the key in Admin → Credentials, turn
embedding on, and run the estimated Rebuild in the Vector section. `EMBEDDING_<PROVIDER>_API_KEY` in the shell is only the prompt's
default, never read at runtime. A new install is steered to Gemini Embedding 2 at 3072
dimensions — with a **paid** key; on the free tier Google may use the embedded content.

## Custom LLM endpoints

The wizard's endpoint step registers chat-model sources into `platform.json`'s
`localLLMs` list. Without `--advanced` it adds a detected Ollama or local server and asks
nothing; with it, it auto-probes the standard local ports (Ollama, LM Studio,
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

The `--advanced` Vector step's *Custom endpoint* row registers one OpenAI-compatible
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
| Everything in `platform.json` | Those are admin decisions made through the UI. Only missing keys are added; of the package-declared tunables setup seeds only the embedding target and, for a no-embedding choice, `embeddingEnabled: false` — every other tunable (agent step cap, temperature, project cap) is resolved from its declaration, because seeding one freezes a value the package owns. |
| `<NEURALIS_HOME>/app/config/session-secret.key` | The session secret. Rotating it invalidates every session — everyone is logged out with no warning. To rotate deliberately, delete the file with the app stopped and re-run setup. |
| `QDRANT_API_KEY` | Every Qdrant client authenticates with it and the compose hands the SAME value to the Qdrant server — re-minting it over a live value locks the server out until the next recreate. Minted only in docker/binary modes; in external mode the wizard asks (empty = unauthenticated server) and preserves what you typed. Delete the line to rotate deliberately, then recreate the stack. |
| Existing source configs | They carry edits to permissions, uri-policy rows and sync excludes. Only a missing one is seeded. |
| Users and projects | The wizard has never deleted either. |
| `NEURALIS_COMPOSE_PROJECT` | The Compose project name prefixes the named volumes, the networks and every container name — renaming it orphans `qdrant-data`. |
| `NEURALIS_IMAGE_TAG` | The release an install that runs the published image is on; the compose file pins exactly that tag. A fresh install records the version it was set up from; an update moves it (`neuralis update`, or the hand edit below), and re-deriving it would step the install back. |
| `<NEURALIS_HOME>/qdrant-version.json` | The Qdrant version the storage is on; the compose file renders exactly it. Only `neuralis qdrant-upgrade` advances it. A missing one is recorded from what setup detects (the running server, else the compose tag or the installed binary) — or, for an install with no storage yet, the shipped version. |

One edge of the preserved settings: the "key already stored" probe reads the GLOBAL credential directory only, so a key kept at another scope plus an empty
answer on a re-run seeds `embeddingEnabled: false` (re-enable it in Admin → Config). A genuinely fresh install is a fresh data directory, not a re-run.

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
  mode): it writes no compose file and no binary, and names `neuralis qdrant-upgrade`.
  An existing install meets this at the first `--compose-only` after the update, and a FULL
  setup beside its own running docker-mode Qdrant too: a re-run keeps the mode it recorded.

Setup also *reports* source-config directories with no matching project record —
residue from the old name-mismatch behaviour. It never deletes them; project
removal is a guarded operation that belongs to the app.

## The compose file is generated, not shipped

It carries concrete machine-specific values — user and group IDs, the Docker socket
group, ports, the Qdrant URL for the mode you chose — and a version-stamp header. It is
**not** hand-edited: regenerate with `neuralis setup --compose-only`. The one
interpolation left in it is `QDRANT_API_KEY`, from `.env` (the compose file never carries a
secret; the session secret is a file in the data home the app container binds). A compose file
an older setup wrote still interpolates `${NEXTAUTH_SECRET:?}`: regenerate it before the `.env`
line goes, or every compose command dies on it — and until it is regenerated (`setup
--compose-only`, or `update --apply`) it passes that leftover line into the container's
environment, where `docker inspect` still shows it. In docker mode `--compose-only` refuses
loudly — writing nothing — when `.env` has no `QDRANT_API_KEY`: the emitted
`${QDRANT_API_KEY:?}` interpolation would otherwise make every compose command die,
`down` included. The refusal names the fix (re-run the full setup, or add the line).

An install that runs the published image gets `image: neuralisapp/neuralis:<tag>` with the
`.env` `NEURALIS_IMAGE_TAG` value — never a moving tag, never a default: without the line
`--compose-only` refuses the same way, writing nothing. To move to another release (or back
to the previous one) by hand, change that line, then `neuralis setup --compose-only`
(`neuralis setup --compose-only` in an image-only folder) and `docker compose up -d -V` —
`update --apply` does all of it, on an npm install folder and an image-only folder alike. An npm install folder that registers packages of its own runs its
derived image instead: a `build:` block over the generated `operator-image/` context (a Dockerfile
`FROM` that same tag, `operator.json` — the folder's dependency lines but `neuralis` — and a copy of
the build helper) with `image: neuralis-<project>:<tag>-<hash>`; the hash covers the context, so a
new package set or release is a new name and an unchanged one builds from cache. No operator
package, no context: the plain `image:` line. The development checkout's `build:` block is
described next.

On an install that builds an image — the development checkout's whole image, or an install
folder's derived one — the `neuralis` service's `build:` block is derived here too: one named context per registered local package (a folder or tarball
that no longer exists stops the regeneration, named), the `<NEURALIS_HOME>/build/`
folder (the kept build lock and the private-scope record, which this step feeds), and —
when `.env` names `NEURALIS_BUILD_NPMRC` — that file as a build secret (its PATH only;
a default `registry=` line or no scope line is refused). Any other image install (a public clone,
a pulled image) builds nothing, so setup names a registered local package such an image cannot
carry.

Up to three services are emitted:

- **`neuralis`** — the host: UI, API, in-process package runtime, embedded MCP HTTP
  service. Publishes `3100` (app), `3101` (MCP + package companion surfaces), `3102`
  (the MCP Apps sandbox origin), and `127.0.0.1:1455` — the Codex login callback, host
  loopback only — ONLY when `.env` says `NEURALIS_CODEX_LOOPBACK=on` (default `off`;
  `setup --advanced` asks it on Docker, defaulting to the current value — or edit `.env`,
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
- **`ollama`** — emitted only if you chose a compose-managed local model runtime (`--ollama docker`):
  the pinned image, published on the host's `127.0.0.1` only — Ollama has no login, so neither the
  LAN nor a tunnel ever reaches it.
- **`cloudflared`** — emitted only while a tunnel is on (`.env NEURALIS_TUNNEL=cloudflare`, written by
  `neuralis tunnel on`): the pinned image in the app's network namespace (`network_mode:
  service:neuralis`), the tunnel folder of the data home mounted read-only. It dials the app on
  `127.0.0.1` like the desktop app's own connector.

**The Qdrant dashboard switch:** the static web UI at `127.0.0.1:<NEURALIS_QDRANT_PORT>/dashboard` (6333 by default) is ON
by default. To turn it off, set `QDRANT_DASHBOARD=off` in `.env`, then
`neuralis setup --compose-only` and `docker compose up -d` — the regen emits
`QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false` to the qdrant service (the API is
unaffected). Setting it back to `on` (or removing the line) and repeating the two
commands restores it. A FULL setup re-run rewrites the line to `on`.

**Qdrant telemetry is off** in every generated compose and on every native (binary-mode)
start (`QDRANT__TELEMETRY_DISABLED=true` — on-prem, no phone-home). `neuralis rebuild`
regenerates the compose file before every build, but an already-running Qdrant keeps
reporting until it is recreated: `neuralis setup --compose-only` and then `docker compose up -d qdrant`.
That recreate stops any optimizer run in progress (it starts over), so run it when
`GET /collections/<collection>/optimizations` lists nothing under `running`. Afterwards the
qdrant log no longer prints `Telemetry reporting enabled`.

**Migrating an existing install to the authenticated Qdrant:** re-run
`neuralis setup` (it mints and preserves the key), or add a
`QDRANT_API_KEY=<random>` line to `.env` by hand, then
`neuralis setup --compose-only` and `docker compose up -d`. One recreate carries
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

With Docker and no Node.js, the wizard runs in a one-shot container of the image and
writes the install folder onto host binds (Linux or WSL2):

```bash
NEURALIS_TAG=latest   # or a release tag: https://hub.docker.com/r/neuralisapp/neuralis/tags
mkdir -p ~/.neuralis ~/neuralis && cd ~/neuralis
docker run -it --rm --user "$(id -u):$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v "$HOME/.neuralis:/.neuralis" -e NEURALIS_HOST_HOME="$HOME/.neuralis" \
  -v "$PWD:$PWD" \
  neuralisapp/neuralis:"$NEURALIS_TAG" node bin/neuralis.mjs setup --output "$PWD"
docker compose up -d
```

The first line picks the release — `latest`, or a release tag; on a fresh install the wizard
records the exact version baked into that image as `NEURALIS_IMAGE_TAG`, so the stack never runs a
moving tag. What each part is for:

- **Both folders exist before `docker run`**, or Docker creates the bind sources root-owned.
- **`--user "$(id -u):$(id -g)"`** — the wizard writes the data home and the folder as you,
  and its detection then records your ids (and, through the bound socket, the socket's group)
  in the compose file. Without it the image's own user cannot write a home you own: setup
  refuses with the data-root check and names this flag.
- **The socket, with its group added** — setup uses it to detect Docker and to read the vector
  store's volume. It starts no desktop-image pull there (a pull in the one-shot container ends with
  it): the summary names `docker pull <the desktop image>` after the next steps, and the installer
  below runs it on the host. Without a Docker answering through it,
  setup in the image refuses before writing anything.
- **`NEURALIS_HOST_HOME`** — the compose file binds the data home by its HOST path, and the
  container sees only `/.neuralis`. In the image setup refuses without it while the home is
  `/.neuralis`; a home bound at its own host path (`-e NEURALIS_HOME=<path> -v <path>:<path>`)
  needs none. The running app container carries the same value, so a `--compose-only` there
  binds the host paths too.
- **The folder at its own path, and `--output "$PWD"`** — `.env` and the compose files land in
  it, and every path setup prints is a host path. Without a bind under it, setup refuses.

A refusal prints the command and writes nothing. `--uid`, `--gid` and `--docker-gid` still
override what detection recorded. Every later run in that folder — `setup --compose-only`, the
update — is `neuralis <verb>`, which starts the same one-shot container with these binds.

The container's loopback is not the host's: setup does not see an Ollama or Qdrant running on
the host, and the in-setup ChatGPT sign-in (`--advanced`) cannot receive its callback. On Linux
add `--network host` to the `docker run` for both; otherwise add the providers later in Admin.
Setup in the image never offers to start the stack — a container cannot start its own; the
installer asks, and the manual form's next line is `docker compose up -d`.

**The installer** — `curl -fsSL https://neuralisapp.com/install.sh | sh`, served from the docs
site's `public/install.sh` — is this block as a POSIX `sh` script. It refuses without a terminal
(setup asks questions; under a pipe the script itself is stdin, so `docker run -it` reads
`/dev/tty`) and names the download-read-run form; checks `docker`, `docker info` (naming the
"cannot reach Docker without sudo" case) and `docker compose version` before writing anything;
takes the socket from `docker context inspect` (only a `unix://` endpoint — anything else is
refused by name, never replaced with the literal path) and binds it at `/var/run/docker.sock`;
pulls the image explicitly, then reads the socket's group INSIDE it (`--entrypoint stat … -c %g`),
so the host needs no GNU `stat -c`; runs the block's `docker run` with arguments after
`sh -s --` forwarded to setup; asks "Start Neuralis now? [Y/n]" (`docker compose up -d`, then the
`.env` `NEXTAUTH_URL`); and, whatever the answer, starts `docker pull` of the `.env`
`NEURALIS_MACHINE_IMAGE` on the host under `nohup`, appending to
`~/.neuralis/app/logs/machine-image-prefetch.log`. `NEURALIS_TAG` and `NEURALIS_DIR` override the
release and the install folder. Last it installs `neuralis`: `@neuralis/cli` through npm where
Node.js 22.22+ may write the global prefix, else a script at `~/.local/bin/neuralis` that finds the
folder as the CLI does and runs the image's CLI with the standard binds (a folder before 0.3.3
runs in the installer's release, which can update it). An unwritable `~/.local/bin`, or a
`neuralis` there it did not write, is refused before any write; an existing install is never
set up again (main page). A host test holds both `docker run` forms to `imageSetupCommand` and runs both branches on a fake Docker.

## Installing without Docker

The same host runs natively on Node 26 or newer from a folder that IS the host package — a clone of the public host repository: there, run `neuralis setup`, `npm run build`, then `neuralis start` (the app on the port `.env` names; `npm run start` binds 3100). Setup writes `.env` beside the host on this plane, where Next loads it; inside a pulled container it uses the persistent `NEURALIS_HOME`, and `--output` overrides either location. An npm install folder carries the host package under `node_modules/neuralis` and keeps `.env` and the compose files at its own root, for the Docker shape. You
supply a Qdrant instance (`QDRANT_URL`, default `http://localhost:6333`). With no reachable Docker
the wizard first asks its ONE question (§What setup asks; natively, it downloads the binary for Linux,
macOS or Windows, checks it against its pinned sha256 and starts it);
`--advanced` also offers an external URL. With Docker answering, a native run's default Qdrant is
the compose service, and the next steps start it first (`docker compose up -d qdrant`). Without a reachable Qdrant the host still
starts in a degraded in-memory vector mode and re-probes in the background.

The desktop app's host — `neuralis up`, adopting a home a Docker install set up, its vectors: `desktop-and-native-host.md`.

## Boot environment

| Var | Purpose | Notes |
|---|---|---|
| ~~`NEXTAUTH_SECRET`~~ | — | Not an environment value any more: the session secret is the data home's `app/config/session-secret.key` (setup writes it; the offline `session-secret-v1` upgrade moves an older `.env` value there). A leftover `.env` line is read by no build and no boot (an un-regenerated compose file still passes it into the container — §The compose file is generated). |
| `NEXTAUTH_URL` | Public app URL | Undeclared, the host answers loopback on its own `NEURALIS_APP_PORT` — a dev convenience, **not** a working remote fallback. Must name the origin users actually reach (LAN IP / hostname / domain + port) on any non-localhost deployment, together with `APP_URL`; authentication and OAuth callbacks resolve against it server-side. `.env` is the one source: the compose file passes it through `env_file` and sets no copy of its own, so an edited `.env` holds after `docker compose up -d`. On a loopback install the other spelling (`localhost` ↔ `127.0.0.1`) redirects here, and a proxy forwards `Origin` / `Sec-Fetch-Site` unchanged — a cookie-carrying write is accepted from this address only. The login page navigates to a target validated against the browser's own origin (`src/app/auth/callbackUrl.ts`), so a stale value no longer throws users at localhost after login — but every server-issued callback still uses this value. |
| `NEURALIS_APP_PORT` | Next.js port | Defaults to `3100`. The full setup checks every published port and offers a free one when it is taken; `--compose-only` refuses a busy one and names the `.env` line. |
| `NEURALIS_QDRANT_PORT` | Loopback REST port of this install's own Qdrant — docker mode publishes `127.0.0.1:<port>:6333`, binary mode listens on it | Defaults to `6333`. Chosen by the full setup when 6333 is taken, kept on a re-run, read by `neuralis backup` and `qdrant-upgrade` for the host-side URL. |
| `NEURALIS_QDRANT_GRPC_PORT` | Binary mode's gRPC listener | Defaults to `6334`; chosen beside the REST port. A binary Qdrant gets an authored environment — loopback, these two ports, its storage, its key — and runs in its storage folder. |
| `MCP_HTTP_PORT` | Native MCP listener / Docker published port | Defaults to `3101`; generated Docker compose keeps the container listener on `3101` and maps the chosen host port to it. |
| `OAUTH_JWT_KEY_ID` | `kid` header of the access tokens the `:3101` OAuth server signs | Optional, default `neuralis-1`. Read by agent-core's MCP companion at mount. Change it only together with a key rotation, so clients that cache the JWKS re-fetch it. |
| `OAUTH_ACCESS_TOKEN_TTL` | Lifetime (seconds) of a `:3101` OAuth access token | Optional, default `3600`. Deploy topology, not a platform-config key: a config write must never be able to widen a token's lifetime. Refresh and auth-code lifetimes are code constants. |
| `KEEP_ALIVE_TIMEOUT` | :3100 server keep-alive timeout (ms) | Default `55000` (baked in `Dockerfile`; the prod `next start` script takes it via the `--keepAliveTimeout` flag in `package.json` — `next dev` does not accept the flag). Raised from Node's 5s default to kill the reused-keep-alive-socket `ERR_CONNECTION_RESET` race; stays under the 60s `headersTimeout`. Preserve SSE and WebSocket transport through the reverse proxy. |
| `NEURALIS_HOME` | Data root (in-container: `/.neuralis`) | Setup auto-detects per platform. The desktop app keeps its `.env` in `<NEURALIS_HOME>/app/config`. |
| `NEURALIS_BIND_HOST` | The one address the app, the MCP server and the sandbox origin listen on | Unset in a container (every interface; the port publish is the boundary). The desktop app's setup writes `127.0.0.1`, and `neuralis up` hands it to the app as `HOSTNAME`. A value that is no IP address stops the MCP server rather than binding every interface. |
| `NEURALIS_HOST_HOME` | Host path of the data home: the default `data`/`packages` project sources' host-pair root, and the compose binds setup writes from inside a container | Required in Docker so vector payloads carry host paths, not container paths. Setup run in the image refuses without it while the home is `/.neuralis`. Custom mounts use the `NEURALIS_MOUNT_*` pair instead. |
| `NEURALIS_MOUNT_<slug>` / `NEURALIS_MOUNT_HOST_<SLUG>` | Container path + host-pair root for a `neuralis mount` bind | Written to `docker-compose.override.yml`. `discoverRuntimeStack` lists them; `LocalDiskConnector` derives a source's `hostRoot` from the matching pair when the config omits one. |
| `MCP_BASE_URL` | The MCP server's public origin: the OAuth issuer (token, registration, discovery), `/mcp`, the device link and the desktop stream (sign-in, consent and the terminal stay on `APP_URL`; no OAuth redirect lands on it) | Written beside `APP_URL` (the same host on the MCP port, or `https://mcp.<domain>` behind a tunnel); a value the operator declared (one the public origin does not derive) is kept by a setup re-run and named in its summary. Over https on the derived port the proxy must terminate TLS on that port too (setup warns); an https app needs an https MCP origin (its page cannot open a plain-http desktop stream), and unrelated app and MCP domains need a browser that keeps partitioned cookies for the desktop (Safari may refuse; the widget says so). One hostname: `MCP_BASE_URL` = `APP_URL` and everything routed to the app port, which forwards MCP, its OAuth endpoints and the device link itself; a proxy that sends `/mcp` straight to the MCP port must send `/ws/device-link` there too and set `X-Forwarded-For` or be in `NEURALIS_TRUSTED_PROXIES` (else a LAN device reads as this machine). The CLI and devices refuse plain http off loopback (LAN: https or the tunnel). Changing it — or `APP_URL` — retires every sign-in made on the old one: MCP and CLI clients sign in again (a grant is bound to its resource), devices pair again. Origins are topology: an operator `.env` line, never a platform setting. |
| `NEURALIS_MCP_SANDBOX_ORIGIN` | The MCP-Apps sandbox as a full origin (`https://sandbox.<domain>`) | Written by `neuralis tunnel on`, or by the operator for a name of its own (a re-run keeps it): behind a hostname-routed edge there is no port to split the sandbox off with, and the MCP Apps standard requires an origin other than the app's — it never shares a one-hostname install's address. When set, the host fences that `Host` (only `/mcp-sandbox` is served there) and the card frames it; unset, the sandbox is the app's hostname on `NEURALIS_MCP_SANDBOX_PORT`. The shell accepts only the trusted app origin as its parent. |
| `NEURALIS_COMPANION_ORIGIN` | The companion listener's own browser address — where the virtual desktop stream opens | Optional. Unset, it is `MCP_BASE_URL`'s origin. Needed only when `MCP_BASE_URL` equals `APP_URL` (one hostname): then give it a name or port of its own (setup derives `<host>:<MCP port>` on a re-run or `--lan`); a value equal to the app address is dropped, and the desktop then says it has no address. Never the app's address — the stream page comes from the container. |
| `NEURALIS_TUNNEL` | `cloudflare` while a tunnel connector on THIS machine fronts the app | Written and removed by `neuralis tunnel on`/`off` — or by `setup --tunnel DOMAIN [--access WHO]` (either branch), which runs that same `tunnel on` once `.env` is written, its domain checked before setup writes anything (refused with `--output`: it acts on the install folder). The login lockout and the webhook cap then key a LOOPBACK request by its `CF-Connecting-IP` (named residual: a process already on the machine picks its own key). `on` keeps origins not of this machine as `NEURALIS_TUNNEL_RESTORE`; `off` restores them (an unreadable line changes nothing). It grants nothing: the device link takes ANY forwarding header (`Forwarded`, `X-Forwarded-For`, `CF-Connecting-IP`) on a loopback socket for a remote dial, never "this machine". |
| `OLLAMA_MODE` | The local-model companion: `existing` / `docker` / `binary` / `none` (default) | Written by setup (`--ollama`). `docker`: the compose service (Docker install) or the desktop app's companions file, started and stopped by `up`'s one companion starter. `binary`: the desktop app's host fetches the pinned release into `<home>/app/ollama/` and supervises it on loopback `NEURALIS_OLLAMA_PORT` (11435). The client URL is the platform setting `ollamaUrl` (one writer: setup); choosing Ollama seeds the local embedding model `qwen3-embedding:0.6b`, enabled. A later `--ollama` re-points the URL and turns the local model on over a target that is off; `none` hands that model back to the unasked answer (the recommended model, off until its key) — a target you chose and run is never touched. |
| `QDRANT_URL` | Vector DB endpoint | `http://qdrant:6333` in Docker, `http://localhost:6333` native. |
| `QDRANT_API_KEY` | The Qdrant API key — every Qdrant request must carry it | **Setup-generated, mode-conditionally**: minted (preserve-if-exists, the session secret's family) in `docker` and `binary` modes, ASKED FOR in `external` mode (never minted — the server belongs to someone else; empty means unauthenticated), absent in `skip`. Boot-critical **infra env, not a credential**: the Qdrant client is constructed synchronously at boot, before the encrypted store can be decrypted. In docker mode the compose file hands it to the server via `${QDRANT_API_KEY:?}` interpolation (`QDRANT__SERVICE__API_KEY`); in binary mode the setup spawn env carries it. Consumed by brain-core's `QdrantClient`, by `@neuralis/admin`'s REST probes, by `neuralis reset-vector` (`api-key` header — `src/server/config/qdrantFetch.ts` is the host-side helper) and by `neuralis qdrant-upgrade` (the header in-process on the loopback port; a hop container gets it through a 0600 env-file, never argv). The setup-time reachability probe deliberately does NOT send it: it shares one header-free `httpGet` with the Ollama probe, so a key there would reach a different service, and it only calls `/healthz` and `/`, which Qdrant's auth whitelist leaves unauthenticated. Stripped from every agent shell (`/^QDRANT_/` blocklist row) and from helper-child spawns (authored `{ PATH }` env). Surfaced read-only on the Config tab as `(set)` / `(unset)`, never as a value. |
| `QDRANT_MODE` | How Qdrant is provisioned (`docker` / `binary` / `external` / `skip`) | Written by setup; read back by `neuralis setup --compose-only` so the compose regen emits the right qdrant service / `QDRANT_URL` shape without re-asking. The desktop app's `up` reads it too: `docker` starts its own compose file's vector store, `binary` the bundle's binary. |
| `NEURALIS_QDRANT_COMPOSE_DIR` | The desktop app in `external` mode: the Docker install folder whose vector store `up` starts | Written by `setup --native` when it adopts a home whose Docker install runs Qdrant in Docker; the project and service are read from that folder, never stored here. |
| `NEURALIS_CODEX_LOOPBACK` | Codex sign-in loopback publish on the Docker shape (`on` / `off`, default `off`) | Operator opt-in: `setup --advanced` asks it on the Docker shape (default = the current `.env` value, `off` on a fresh install); editing `.env` and running `neuralis setup --compose-only` works too. `on` makes the compose regen publish `127.0.0.1:1455:1455` and set the container's bind to `0.0.0.0`; Docker then holds the host's 1455 while the stack runs. The compose always sets it explicitly in the service environment, so an `.env` flipped without the regen changes nothing. |
| `NEURALIS_TRUSTED_PROXIES` | Reverse proxies (addresses / CIDR blocks, comma- or space-separated) whose `X-Forwarded-For` the host believes | **Default empty: no forwarding header is believed** — the connecting socket is the client. Written by the full setup (asked, default = the current `.env` value) and read at boot. One invalid entry voids the whole list (warned). Topology, not a tunable — never a platform-config key. See "Sessions and request identity". On the desktop app's host everything listens on `127.0.0.1`: a reverse proxy that strips forwarding headers in front of the MCP port MUST be declared here, or every device dialling through it counts as this machine and the unconfined shell may land on it. A connector that ADDS one (`cloudflared` always does) is never this machine either way — do not declare `127.0.0.1` for it: that would also take the desktop app's own device off this machine. |
| `QDRANT_DASHBOARD` | Qdrant web dashboard switch (`on` / `off`, default `on`) | Operator switch for the static dashboard SPA at `127.0.0.1:<NEURALIS_QDRANT_PORT>/dashboard`. `off` makes the compose regen emit `QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false` to the qdrant service (the API is unaffected). Flow: edit `.env` → `neuralis setup --compose-only` → `docker compose up -d`. Not a secret; a full setup re-run rewrites the line to `on`. Bounded exposure either way: the dashboard is a static SPA, its API calls 401 without the key, and after the network isolation it is reachable only from the app container and the host loopback. |
| `BRAIN_INFRA_MODE` | In-process brain (`local`) vs external mode | Default `local`. |
| `NEURALIS_BUILTINS` | Comma-separated FULL package-id list override (e.g. `@neuralis/agent-core,@neuralis/brain-core`) | Optional, a development override. Omit for full builtin set; leaving the virtual desktop out of a deployment is the platform setting `disabledBuiltinPackages`. |
| ~~`NEURALIS_PKG_LINKS`~~ (+ its `NODE_PATH` fallback) | — | RETIRED: a `--pkg` mount binds the folder onto `node_modules/<name>`, so nothing reads a link list: a line an older host left in the override is inert, and `mount add <dir> --pkg <name>` gives that folder its bind. |
| `NEURALIS_BUILD_NPMRC` | Path to the operator's `.npmrc` for a private registry (scope lines only: `@scope:registry=<url>` + its `_authToken` line, never a default `registry=`) | Hand-written in `.env`, carried by setup, never asked. The compose regen passes the FILE to the image build as a BuildKit secret (never a layer, build arg or `compose config` value) and fails, naming the problem, on a missing file, a default `registry=` line or no scope line. `neuralis pkg add` refuses a package whose dependency is in a scope known to be private (`<NEURALIS_HOME>/build/private-scopes.json`, a lock, a manifest) with no line here. |
| `NEURALIS_DOCKER_OVERLAY` | Audit marker for `--with-docker` overlay capability | `1` when the LLM shell can drive the host Docker daemon. |
| `NEURALIS_DOCKER` | "We are running inside Docker" flag | `true` in the generated compose env; setup also reads it. The workspace learns it at runtime from the server (the same detection), so one build serves the image and the desktop app; `neuralis up` never sets it. |
| `LOCAL_UID`, `LOCAL_GID`, `DOCKER_GID` | Container uid/gid + docker-group GID | Written by setup for Docker only; baked into the generated compose (`user:` / `group_add:`). |
| `NEURALIS_COMPOSE_PROJECT` | Docker Compose project name for this install | Written by setup and PRESERVED across re-runs; read back by `--compose-only`. It prefixes the named volumes, the network and every container name, so changing it on an existing install orphans `qdrant-data`. Defaults to `neuralis`; setup derives a distinct name only when Docker reports another project already claiming it: `neuralis-<folder>` from the install folder, and when that is taken too, a short hash of the folder's path is appended. |
| `NEURALIS_VERSION`, `NEURALIS_REVISION` | What this deployment was built from | Baked into the image from build args, and surfaced in the AUTHENTICATED admin environment table. Absent on a source checkout, where the tree is the answer. The anonymous health endpoint deliberately carries no version; its per-process random `instanceId` is intentional — the data-home lock's liveness answer (a restart reveals itself, nothing else). |
| `MAX_AGENT_STEPS` | Env fallback for the per-stream step cap | The setting lives in `platform.json` as `maxAgentSteps` (editable in Admin → Config; the DECLARED default is 2000 — agent-core's `configSettings[]`); a stored value wins over this env. Setup no longer seeds it: a seeded value would freeze a number the package owns, and the 40 it used to write acted as a hard ceiling. |
| `NEURALIS_STREAM_TIMING` | Env fallback for the `streamTimingEnabled` platform setting (`1` or `true`) | The toggle lives in Admin → Config → Debug ("Stream Timing"); a stored value wins. When on, one `TEMP_TIMING_SUMMARY` block per stream (setup-phase deltas + per-step cache hit%). Resolved per stream — no restart needed. |
| Machine-core knobs (`NEURALIS_MACHINE_*`) | Webtop image, variant, idle, recording TTL, key-combos + infra (socket, ports, network, seccomp) | The TUNABLE set (image, variant, idle, recording TTL, key-combo exceptions) is admin-editable platform config (env = fallback: setup writes no variant/idle line, a hand-set one reaches the container through `env_file`); the docker socket path, CDP/sidecar ports, shared network and seccomp stay env-only infra. |
| ~~Channel webhook secrets (`TELEGRAM_*`, `WHATSAPP_*`)~~ | — | channel secrets live exclusively in the `CredentialStore` at the connection's owning scope (`telegram.*` / `whatsapp.*` ids, per-connection derived); never env. |

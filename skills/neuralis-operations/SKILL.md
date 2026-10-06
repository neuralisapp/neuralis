---
name: neuralis-operations
description: "Every host operator command for a Neuralis deployment — setup and compose, rebuild, live package sync, filesystem mounts, first-party package registration, the host-access broker, break-glass user recovery, vector reset, the Qdrant upgrade and the backup and restore of the whole install. Use when someone asks how to install, update, restart, mount, extend or diagnose the deployment itself, rather than to work inside it."
allowed-tools: [execute]
---

# Operating a Neuralis deployment

These are the commands that act on the **deployment** — the image, the container, the
mounts, the packages installed into the host. They are not part of the product surface
an agent works through; they are what an operator runs on the machine that hosts it.

**Every command is on this page.** The `references/` files exist for when you have to
explain one to a person, or when a command failed and the reason is not obvious.

## Before anything: where do you run these?

There is no fixed path. Run them **where the host folder is**, and which folder that
is depends on how this deployment was installed:

| How it was installed | Where the commands run | What the folder is called |
|---|---|---|
| `npm create neuralis <dir>` | `<dir>` — a project the operator owns | the scaffolded install |
| `git clone` of the public host repo | the clone root | the repo *is* the host folder |
| the private monorepo | `neuralis/` inside the checkout | a workspace member |
| `docker pull` only | **there is no host folder** | see the container form below |

In the first three, the form is `pnpm <command>` from that folder. Confirm you are in
the right one before running anything: the folder holds a `package.json` named
`neuralis` that depends on `next`, next to a `Dockerfile` and a `scripts/` directory.

With a pulled image and no host folder, the same tooling is **baked into the image** at
`/neuralis/scripts/`, and runs inside the container:

```bash
docker exec neuralis-neuralis-1 sh -c 'cd /neuralis && node --import tsx scripts/mount.mts list'
```

That form is read-friendly and mutation-hostile: it can inspect, but anything that
writes compose files, rebuilds an image or restarts the stack has to act on the host,
because the container cannot recreate itself. Say so plainly rather than trying.

**Running these yourself requires the host-access plane** — `exec.host`, an
operator-provisioned broker, and the target path inside the broker's allowlist. None of
that can be arranged from inside the platform; it is a deliberate floor, described in
`references/host-plane.md`. Without it, report the command for a human to run instead
of attempting it.

## The commands

### Install and configure — `pnpm neuralis:setup`

```bash
pnpm neuralis:setup                 # wizard: data dirs, .env, compose file
pnpm neuralis:setup --compose-only  # regenerate docker-compose.yml only
```

Run it **before** the first `docker compose up`, or Docker creates the data
directories first and they end up root-owned. It writes `~/.neuralis/{app,projects}`,
the `.env` (including `NEXTAUTH_SECRET` and — in docker/binary Qdrant modes — a minted
`QDRANT_API_KEY` the server then enforces on every request), the first owner account
and project, and **generates `docker-compose.yml`** for this machine.

**Re-running is supported and non-destructive** — it is how infrastructure answers
change (ports, public origin, vector backend, desktop variant). What a re-run does
NOT do: overwrite settings changed in the admin UI (platform config is merged, and
package-declared tunables are not seeded at all), rotate the session secret, the
MCP API key or the Qdrant API key (all preserved — rotating them logs everyone out /
breaks every MCP client / locks the running Qdrant out until a recreate), rewrite
source configs you have edited (only a missing one is seeded), or create a second
project: it maintains a project that already exists, named by its name or its id (the
id when two share a name), under that project's own id and owner — anything else is
REFUSED. A genuinely fresh install is a fresh data directory, not a re-run.

`--compose-only` REFUSES (writing nothing) when `.env` lacks a value the compose file
needs — `NEURALIS_IMAGE_TAG` on an install that runs the published image, `QDRANT_API_KEY`
in docker Qdrant mode — and names the fix; and the `.env` `QDRANT_DASHBOARD=on|off` switch (default `on`)
controls the static dashboard UI — flow and details in
`references/setup-and-compose.md`.

One answer has no safe default: the **public origin**. It is what `NEXTAUTH_URL`,
`APP_URL` and `MCP_BASE_URL` become, and the wizard cannot detect how users will
reach the deployment. Leave it at localhost only for a single-machine install.

The Vector step asks for the embedding model and **its own key** — `embedding.openai`,
`embedding.gemini`, `embedding.qwen`, `embedding.voyage`, or `embedding.endpoint.<id>` for a
custom OpenAI-compatible `/v1/embeddings` server. It is not the chat key: embedding spend is
counted and capped on its own, and embedding stays off until the key is set (Admin →
Credentials works too). `EMBEDDING_<PROVIDER>_API_KEY` in the shell is only the prompt's
default, never read at runtime. A new install is steered to Gemini Embedding 2 at 3072
dimensions — with a **paid** key; on the free tier Google may use the embedded content.

The compose file is a generated artifact, never hand-edited — `references/setup-and-compose.md`
covers what is in it and what regenerating does to your changes. Its **project name**
is recorded in `.env` (`NEURALIS_COMPOSE_PROJECT`) and preserved across re-runs: it
prefixes the named volumes and every container name, so changing it would orphan
`qdrant-data`.

### Rebuild the image — `pnpm neuralis:rebuild`

```bash
pnpm neuralis:rebuild               # the ONLY supported rebuild
```

Never substitute a raw `docker compose` invocation. The wrapper regenerates the compose
file (the build's local packages and private-registry secret are derived from it), runs the
load-bearing `up -d --build -V` from the right directory with no `-f` flag, prints what the
build refused, and performs bounded cache cleanup. Each step is load-bearing and skipping
one has caused real outages — `references/rebuild-and-sync.md`.

Rebuild when: a package was registered or removed, any package source changed, any host
`src/` changed, or dependencies or the Dockerfile changed. A package UI's Tailwind classes need no trigger of their own: the host
compiles one stylesheet from every first-party UI module's `app/` sources when it loads the
package set. Do **not** rebuild for `~/.neuralis` config or credential edits — those are
read live.

The same run keeps the managed MCP sidecar image (`neuralisapp/mcp-sidecar:dev`) current,
but only when there is a reason — the image is missing or its source-hash label differs from
`packages/agent-core/docker/mcp-sidecar/` — so an unchanged sidecar costs one line and no
build; `--no-sidecar` skips it, a failed sidecar build is reported and never fatal, and an
installed tree (no `docker/`) skips it by name. The desktop image stays a separate build.

**An agent whose shell runs INSIDE the platform container cannot run this**, and that
holds even when the host folder is visible at `/mounts/repo` and the Docker socket is
reachable: the command would replace the very container the shell lives in, and the
container's Docker CLI carries no BuildKit plugin, so the build dies partway with
`--mount option requires BuildKit` while the running container is never recreated.
Report the command for the host operator to run and say plainly that you cannot;
polling a build that structurally cannot succeed is the failure mode this sentence
exists to prevent.

### Swap a package without rebuilding — `pnpm neuralis:sync`

```bash
pnpm neuralis:sync status           # what diverges from the container; changes nothing
pnpm neuralis:sync my-package       # rebuild + swap that package (~1 min vs ~6–10)
pnpm neuralis:sync @acme/my-package # the full registry name works too
pnpm neuralis:sync --all
pnpm neuralis:sync --dry-run        # the whole plan, no writes
pnpm neuralis:sync --no-restart     # swap but leave the process alone
pnpm neuralis:sync --json
```

This is the fast inner loop for **developing your own first-party package**. What is
syncable is derived from the host's dependencies: any dependency whose manifest carries
a `neuralis` block and resolves to a directory on this machine. A dependency installed
from a registry has no source here and is reported as such. A local folder builds in its
OWN root (its `build`, then its UI module), so it must build on its own — its
devDependencies installed in it; a folder bound with `mount add --pkg` is then not
swapped: the container reads it already, and the restart loads it.

**A synced container is a DEV container.** A full `pnpm neuralis:rebuild` is still
required before any deployment judgement; sync writes a divergence marker so that rule
is checkable rather than remembered. Every refusal it prints is a case where the swap
would produce a container that looks updated and is not — never argue with one, and
never work around it.

### Update to newer package versions — `pnpm neuralis:update`

```bash
pnpm neuralis:update                          # show the plan; changes nothing
pnpm neuralis:update --version 0.2.0 --apply  # install that version everywhere
pnpm neuralis:update --manifest ./line.json --apply   # a published release line
pnpm neuralis:update <package>                # limit to one package
pnpm neuralis:update --json
```

Targets the packages installed **from a registry** — the exact complement of what
`neuralis:sync` handles. Both come from one derivation, so a package is always in
exactly one of the two: source here means sync, no source here means update.

`npm update` cannot do this job, which is why the command exists: the host pins
its `@neuralis/*` dependencies exactly (so `npm update` is a no-op against them),
npm has no scope glob, and `npm install @neuralis/x@latest` rewrites the exact pin
into a caret range — silently turning a tested release line into "whatever
resolves today".

Without a version source it stops and says so. Resolving each package's newest
version independently would assemble a combination nobody has ever run; a release
manifest names a TESTED one. Until such a manifest is published, `--version` is
the supported path. On the development checkout the command refuses outright —
there the update is `git pull`.

The container runs the image the `.env` `NEURALIS_IMAGE_TAG` names, at that exact tag —
never a moving one. An all-package `--version <x> --apply` moves the tag to `<x>` once the
install succeeded; a single-package or `--manifest` run leaves it and says so. With no host
folder (`docker pull` only) the update is that `.env` edit by hand. Either way, then
regenerate compose (`pnpm neuralis:setup --compose-only`) and recreate with
**`docker compose up -d -V`**. The `-V` is load-bearing — without it the anonymous volumes
mask the new image-built runtime and the update appears to do nothing. Going back is the
same three steps with the previous tag.

### Expose a host folder — `pnpm neuralis:mount`

```bash
pnpm neuralis:mount add <host-path> [--slug <name>] [--project <id>]   # a data source
pnpm neuralis:mount add <host-path> --neuralis [--with-docker]         # the /neuralis overlay
pnpm neuralis:mount add <host-path> --pkg <package-name>               # a package folder
pnpm neuralis:mount list [--project <id>]
pnpm neuralis:mount remove <slug> [--project <id>]
pnpm neuralis:mount remove --neuralis
pnpm neuralis:mount remove --pkg <package-name>
```

Without `--project`, `list` shows every project's attachments and `remove` checks every
project's source configs for references — a mount is instance-wide.

Mounting only makes the folder **visible** to the container; it does not attach it. The
operator then attaches it as a filesystem source from the Files UI. A restart is needed
in between. `--neuralis` binds the host folder onto `/neuralis` so the deployment can
read its own tooling and skills live — that is what makes the `neuralis://` source
show current content rather than what the image baked.

**`--pkg` and a plain data mount are not alternatives, and `--pkg` does both jobs.** It
binds the folder onto `/neuralis/node_modules/<name>` — over the copy the image installed,
its own `node_modules` masked so the image's one kernel and one React serve it — **and**
writes the `/mounts/<slug>` bind with its `NEURALIS_MOUNT_<slug>` / `NEURALIS_MOUNT_HOST_<SLUG>`
pair. That pair is not decoration: it is how a source rooted at the mount derives its
host path. Without it the operator has to type `hostRoot` into the source by hand, an
explicit value wins over every derivation, and a wrong one persists with nothing
validating it. You cannot get the pair by running a data mount over the same slug
afterwards — both add forms refuse a container path that already exists. **A mount slug
may contain `-`, and the metadata names normalise it to `_`** (`my-pkg` →
`NEURALIS_MOUNT_HOST_MY_PKG`); the two sides agree, so do not "fix" one of them.

**`mount remove --pkg <name>` alone leaves the package registered.** It drops both binds,
the mask and the host pair; the dependency line survives it, and the next start loads the
image's installed copy. `pkg remove` takes out both the line and the mount.

**A source over a folder of skills is a discovery mechanism, not just access.** A directory
containing a `SKILL.md` is treated as a package root, so attaching a read-only source over the
deployment's `skills/` folder makes each one a *discovered source package* that reaches an agent's
context by itself, instead of a file someone has to know to open. Root it at the skills folder and
**never at the deployment root** — that directory holds the `.env` carrying the session secret and
the vector-store key, and a source there would put both into agent reach and into the vector index.

With the overlay configured, Files → Discover offers this ready-made, narrowest first:

- **Neuralis Skills** — rooted at `<overlay>/skills`, user-scoped, manual sync, and read-only via a
  `**` write/exec deny. This is the one to click. The root *is* the boundary, so nothing outside the
  skills folder is reachable, and no filter has to hold the line. It appears only when the overlay
  root actually has a `skills/` folder — better no row than a row pointing at nothing.
- **Neuralis Tree** — the whole overlay, for editing platform source. It pre-fills
  `include: ['skills/**']` so a "turned it on and left it" attach does not index the entire folder,
  plus denies on the two things that make this root dangerous: `.env*` (no read, no write — it
  carries the session secret and the vector-store key) and write on `Dockerfile`, `docker/**` and
  every compose file the daemon would pick up. That last set is wider than the file this repo
  ships: `neuralis:rebuild` runs `docker compose up` with no `-f`, so Compose's default discovery
  applies — `compose.override.yaml` and `docker-compose.override.yaml` beside the base are MERGED,
  and a bare `compose.yaml` REPLACES it — so all four spellings, `.yml` and `.yaml`, are denied. Ordinary editable rules, not immutable floors; the owner
  can remove any of them before or after saving.

**Two traps, both of which look closed when they are not.** A sync `include` decides what gets
INDEXED, never what `fs_read` can reach — the source root and the path rules do that. And a
"read-only" attach cannot be expressed through the default access block: attaching at any scope
other than project rewrites `default` to all-false and grants the creator read+write+exec directly,
so read-only needs an explicit path row. Both proposals above are built that way.

Mounts are written to a machine-local `docker-compose.override.yml`, which survives
regenerating the base compose file. The two have opposite lifecycles on purpose —
`references/mounts.md`.

### Register a first-party package — `pnpm neuralis:pkg`

```bash
pnpm neuralis:pkg list                                  # builtin-class deps
pnpm neuralis:pkg add <name> --path <abs-host-dir>   # a folder you are developing — the image build builds it (ABSOLUTE path: a relative one resolves from the shell's cwd)
pnpm neuralis:pkg add <name> --tarball <x.tgz>       # a packed package, installed as packed
pnpm neuralis:pkg add <name> --version <x.y.z>       # a registry package at an EXACT version, public or private
pnpm neuralis:pkg remove <name>                      # line + mount out; default role grants revoked at the next start
pnpm neuralis:rebuild                                # after either: the image installs or drops it
```

**This is a trust act, not a convenience.** Presence in the host's dependencies is the
authorization boundary: a dependency carrying a `neuralis` block is discovered at boot
and loaded **in-process with first-party trust** — the same trust the platform's own
packages hold. Vet it as you would vet any dependency you are about to run unsandboxed.
Every check runs BEFORE the write, so a refused add changes nothing; a package that still
fails at build or start is left out alone and named (Admin health). An add is also recorded
so the first start that carries the package grants its default roles in every EXISTING
project once (re-run `add` for one already registered to do the same). The loop, the build
contract, a private registry (`NEURALIS_BUILD_NPMRC`) and removal: `references/own-packages.md`.

**A tool name is one key for the whole deployment, and adding a package can take one.**
There is no per-package prefix: if the package you register declares a tool name an
already-loaded package uses, one of them answers the bare name by default and the other
stays loaded — the first-party entry wins, and between two first-party entries (which
every registered dependency is) the lexically smaller package id does. Nothing is
renamed and **nothing refuses to start** — a collision is a diagnosable annoyance, never
an outage. The boot log carries a `Namespace collisions detected` line naming the owner
and the shadowed ids, and the agent tool catalog lists the name under `contestedTools`,
where an agent's Tool Access can pick the other package. If calling a newly registered
package's tool answers from somewhere else, that is this: the name is contested, and the
durable fix is a rename in the package, not a reinstall.

**A local source (`file:`/`link:` dep line) builds into THIS machine's image and is never
committed.** The drift tests exclude it and `npm pack` refuses while one exists. Host-dev
lane: `pnpm install --lockfile=false` — a plain `pnpm install` would write the
machine-absolute path into the tracked `pnpm-lock.yaml` (recovery: `git checkout --
pnpm-lock.yaml`; `neuralis:rebuild` preflights this and names the fix). A package's
direct-render widget/card UI renders only from its prebuilt UI module (`app.module`,
`neuralis-build ui` → `dist/app/`): the image build and sync build it for a folder; a
tarball or registry package ships it prebuilt and its owner rebuilds it after a host or
kernel upgrade. Without a module the placeholder *"This widget cannot be rendered by this
host."* shows, and a refused module names its reason there.

### The host-access plane — `pnpm neuralis:host-broker`

```bash
pnpm neuralis:host-broker init      # secret + scratch + a DENY-ALL ceiling; prints the unit
pnpm neuralis:host-broker install   # the confinement helper: copied from the built image, PROVED by --selftest, placed
pnpm neuralis:host-broker upgrade   # install + unit refresh + broker restart — run it after every rebuild
pnpm neuralis:host-broker run       # run the broker in the foreground
pnpm neuralis:host-broker status    # readiness: secret, ceiling, helper + drift, transport, confinement mode, detached runs, pending requests
pnpm neuralis:host-broker grant --exec|--read|--write <dir>   # widen the ceiling for a recorded request; atomic + SIGHUP
pnpm neuralis:host-broker attach    # write a host-plane source config for a project
pnpm neuralis:setup --compose-only  # regenerate compose with the broker binds
```

The allowlist ships **empty**, which denies every host command until the operator names
the paths it may reach — "not configured" never means "unlimited". The broker runs on
the host, never in a container, and an image rebuild never reloads it — nor the
confinement helper it spawns through: a rebuild produces a fresh helper in the image,
`status` (and the end of `neuralis:rebuild`) prints whether the host copy still matches,
and `upgrade` is the one command that brings it back in line (it refuses to restart while a
background host shell is still running, unless forced — a restart kills every host PTY and
every detached run). A helper the selftest cannot prove is reported unusable and the plane
stays dark until then. The ceiling has two modes — sandboxed (default) and the single-operator
`unconfined` — and it is the operator's file: an agent that needs more asks through the
`reason` of the refused command, and `status` lists those requests for `grant`.
`references/host-plane.md`.

### Recover a locked-out account — `pnpm neuralis:user`

```bash
pnpm neuralis:user list                     # every account and its status
pnpm neuralis:user enable <email>           # re-enable a disabled account
pnpm neuralis:user reset-password <email>   # print a one-time temporary password
```

For when nobody can do it in the app: every owner disabled, or the only owner's
password lost. The host shell is the boundary, so it asks no credentials; each change
is confirmed by typing the address again and audited under the operator's OS user
name. A reset forces a new password at login and refuses every earlier sign-in and
every earlier MCP client token at its next use. The command runs outside the app
process, so it closes no connection already open — live updates, terminals, desktop
streams, a running turn: those stay until `docker compose restart neuralis` in the host
folder (it only bounces the process; a host-plane terminal ends with the broker). A
reset made in the app closes them at once. An enable resumes nothing that paused
meanwhile. It never disables or deletes — those stay in the app.

### Reset the vector layer — `pnpm reset:vector`

```bash
pnpm reset:vector
```

Drops the Qdrant collections and the embedding lock. It destroys more than vectors:
**`brain://` content lives only there, so every brain file, its version history and
pending-review records go with it** — only connector-backed sources come back, re-embedded
(and paid for) on their next sync. It is a last resort, not the way to change models.

Changing the embedding model, or re-embedding one source, folder or file, happens inside the
running app, with an estimate before anything is spent: the admin Vector section rebuilds
the index on the new model while the old one keeps serving, and **Re-embed…** in Files (or
the `manage-sources` skill for an agent) re-embeds a scope with the active model. There is no
command-line form — say so rather than improvising one.

### Go back a version — `pnpm neuralis:checkpoint`

```bash
pnpm neuralis:checkpoint list            # checkpoints, newest first, and the data-format ledger
pnpm neuralis:checkpoint restore <id>    # app STOPPED; asks for the id again
```

Every build records which on-disk format of each record kind it reads and writes, in
`<NEURALIS_HOME>/app/config/data-formats.json`. When a new build first boots over older
data, it takes a checkpoint of the control-plane files it is about to upgrade into
`<NEURALIS_HOME>/checkpoints/` and then raises the format; `dataCheckpointKeep` (Admin →
Config, default 5) bounds how many are kept. Credential blobs and the master key are copied
only when the credential format itself is raised. When a build meets data **newer** than it
reads, it does not start: the boot error names the record kind, both versions, the newest
checkpoint and this command.

`restore` refuses while the app answers on its port or `docker compose ps` shows the
`neuralis` service running — stop it first (`docker compose stop neuralis`). Everything
written after the checkpoint is lost, which is why it asks for the id again. With a pulled
image and no host folder, the script is baked in:

```bash
docker compose stop neuralis
docker compose run --rm --no-deps neuralis node --import tsx scripts/checkpoint.mts restore <id>
```

A missing `credential-master.key` beside encrypted credentials is recovered the same way: put
the key back from a backup, or restore a checkpoint that carries it. While `NEXTAUTH_SECRET` is
set (every standard install) the store derives the legacy key from it instead of refusing, so a
lost key file does not stop the boot — it leaves every secret written under the old key
unreadable until the file is back. A checkpoint is a way back one build, not a backup.

### Upgrade Qdrant — `pnpm neuralis:qdrant-upgrade`

```bash
pnpm neuralis:qdrant-upgrade --dry-run            # the hop chain; changes nothing
pnpm neuralis:qdrant-upgrade --rehearse <volume>  # the whole chain on a CLONED volume
pnpm neuralis:qdrant-upgrade                      # the real run: stops the stack
pnpm neuralis:qdrant-upgrade --rollback <dir>     # restore a run's cold backup
```

Qdrant's on-disk format is **forward-only** and upgrades **one minor at a time**, so
the version a deployment runs is recorded install state
(`<NEURALIS_HOME>/qdrant-version.json`), and the compose file runs exactly that version,
digest-pinned. Setup refuses, in docker and binary mode, when the recorded version is more
than one minor behind the shipped one, and names this command — an existing install meets
it at the first `--compose-only` after the update (`neuralis:rebuild` never regenerates
compose). Never edit the compose
image line to "upgrade": a newer engine migrates the storage in place, and a jump across
several minors is unsupported.

The command asks for owner credentials, refuses without twice the storage size free,
checks the source against the settle rule while the app still runs, stops the APP (nothing
may write while it records the point counts every hop must reproduce), copies snapshots out
to `<NEURALIS_HOME>/qdrant-backups/<run>/`,
stops Qdrant, writes a cold tar of the volume, then starts each minor on the
volume (no network, no published port, the key through a 0600 env-file, never argv — the
key lives in `.env`; never paste it into a shared transcript) and
requires the settle rule before the next: ready, `optimizer_status: ok`, not red, and the
exact count equal to the recorded one — green is not required (the status reached is
recorded), and `--settle-minutes` (default 60) is the only bound. The 1.16 hop migrates the
storage engine in the background and can take long. Nothing else may rebuild or recreate
the stack while it runs; a Ctrl-C marks the record `aborted` and prints the command that
continues, without restarting the app. Any failure
restores the cold backup and the previous version; `down -v` is never a recovery — it
deletes the volume and every embedding, and re-embedding costs real provider spend.
Rehearse on a clone first: `docker volume create <clone>`, copy the stopped volume into
it with a throwaway container, then `--rehearse <clone>`.

### Back up and restore the whole install — `pnpm neuralis:backup` / `pnpm neuralis:restore`

```bash
pnpm neuralis:backup                              # stops the app + Qdrant, copies, starts them again
pnpm neuralis:backup --out <dir>                  # default: <home>-backups/<time>, beside the home
pnpm neuralis:backup --include-volume <name>      # also a snapshot / desktop-profile / Ollama volume
pnpm neuralis:backup list                         # complete backups, newest first
pnpm neuralis:restore <dir>                       # app STOPPED; asks for the folder name again
pnpm neuralis:restore <dir> --home <tmp> --volume <clone>   # into a throwaway target
```

A backup is one consistent point: `<NEURALIS_HOME>` (`app/` with the credential master key,
`projects/`, `checkpoints/`, `host-broker/`, `qdrant-version.json`, and in binary Qdrant mode
`qdrant-storage/` — minus `qdrant-backups/`, the upgrade's own rollback tars), the
`<project>_qdrant-data` volume — **primary data, not a rebuildable index: `brain://` content
lives only there** — the host folder's `.env` (it sits outside the home and carries
`NEXTAUTH_SECRET` and `QDRANT_API_KEY`) and `docker-compose.override.yml` (the mounts).
Snapshot exports, `neuralis-machine-*` desktop profiles and `ollama-data` are named and left
out unless `--include-volume` asks for them. It refuses before stopping anything without the
`.env`, without the free space, or with a folder inside the home, the host folder or the repo (a
Docker build context); it refuses while anything else holds the volume, and fails when tar
reports a file that changed while it was read (something still writes under the home — stop it
and re-run). Either way it starts again exactly the services it stopped (`compose start`, never
`up`) and writes no manifest, so a failed folder is never offered. The folder is 0700, every file
0600: keep it private — it holds every secret. The command prints each part's size and the
elapsed time. Relative paths are read from the folder you run it in.

`restore` refuses while the app answers on its port or `docker compose ps` shows it running,
lists every incoming tar before anything moves, saves the CURRENT volume to
`<home>.before-restore-<volume>.tar`, moves the current home to `<home>.before-restore` and
the `.env` and the override to `*.before-restore` — it never deletes, and refuses while an
earlier rescue copy sits in any of those places. A failure half-way names every step already done
and where each rescue copy is. `--home` + `--volume` restore into a throwaway home and a cloned
volume and never touch the live ones. Afterwards always run `pnpm neuralis:setup --compose-only`
(the restored `.env` names the image tag and the Qdrant mode the backup was taken on), then
`docker compose up -d -V`. Never `down -v` on the way.

With a pulled image and no host folder, do it by hand from the compose folder:
`docker compose stop neuralis qdrant`;
`tar -C <home> -cpf <dir>/home.tar .` as a user that can read every file (the master key is 0400);
`docker run --rm --network none -v <project>_qdrant-data:/from:ro -v <dir>:/to alpine:3.24 sh -c "tar -C /from -cf /to/qdrant-data.tar . && chown $(id -u):$(id -g) /to/qdrant-data.tar"`
(any local image with `tar` works); copy `.env` into `<dir>`; `docker compose up -d`. The
restore is the inverse with both stopped: move the home aside, `tar -C <home> -xpf`, and
`find /to -mindepth 1 -delete && tar -C /to -xf /from/qdrant-data.tar` in the same throwaway
container — take a copy of the current volume first, because that `find` empties it.

Going back one build is the checkpoint's job (Go back a version), not this one's. An installed
compose file runs the exact tag `.env` `NEURALIS_IMAGE_TAG` names, so the previous release
stays addressable by its tag — rolling the image back is writing that tag back. Role-grant migration is one-way: a build that raises the
role grants migrates each project record as it reads it, and today such a raise takes no
checkpoint of its own — the way back across it is a full backup taken before the upgrade. From the next role-grant raise on, the `neuralis/project` data format
rises with it, so an older build refuses to start — naming the record kind and the checkpoint
command — instead of serving the project read-only as it does today. Builds older than the
data-format ledger have no such guard: the first published beta is the floor of a safe rollback.

## What these commands never do

- **Never `docker compose down -v`.** It wipes the `qdrant-data` volume — every
  project's indexed memory. Plain `down` keeps named volumes.
- **Never `docker volume prune --all`.** The default form takes only anonymous dangling
  volumes; `--all` also drops named ones.
- **Never hand-edit `docker-compose.yml` or `docker-compose.override.yml`.** Both are
  generated; the next regeneration silently discards your edit.
- **Never `npm install` or `pnpm install` inside the running container.** Both
  tools exist there (pnpm at the repo's pinned version), but there is no lockfile,
  the trees are root-owned, and the next rebuild replaces them. `tsx` is the only
  in-container runner.
- **Never pass `-f` to compose or run it from the repo root.** It makes compose skip
  the override file, and the stack comes up `healthy` with zero mounts — the single
  most recurring failure on this stack.

## Read further

| You need to… | Read |
|---|---|
| Explain the config layers, say what regenerating compose will do, or register a custom LLM or embedding endpoint (local runtime or keyed remote gateway) | `references/setup-and-compose.md` |
| Explain why a rebuild "changed nothing", or why sync refused | `references/rebuild-and-sync.md` |
| Explain why a mounted folder is not visible, or what the overlay does | `references/mounts.md` |
| Walk someone through developing their own first-party package | `references/own-packages.md` |
| Explain what the host plane requires, or why a host command was denied | `references/host-plane.md` |
| Explain what the image build does, or why a package edit needs a rebuild | `references/build-pipeline.md` |

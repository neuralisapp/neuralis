---
name: neuralis-operations
description: "Every host operator command for a Neuralis deployment — setup and compose, rebuild, live package sync, filesystem mounts, installing a package while the host runs or building one into the image, the host-access plane (the server as a paired device), break-glass user recovery, vector reset, the Qdrant upgrade and the backup and restore of the whole install. Use when someone asks how to install, update, restart, mount, extend or diagnose the deployment itself, rather than to work inside it."
allowed-tools: [execute]
---

# Operating a Neuralis deployment

These are the commands that act on the **deployment** — the image, the container, the
mounts, the packages installed into the host. They are not part of the product surface
an agent works through; they are what an operator runs on the machine that hosts it.

**This page is the index:** where each command runs, the first install, and one row per verb.
Each verb's detail — what it does, what it refuses and why — is in the reference its row names.

## Before anything: where do you run these?

Every command is a verb of ONE command line, `neuralis <verb>`. Run it **in the install
folder** — the folder that holds `.env` and the compose files:

| How it was installed | The install folder | The spelling |
|---|---|---|
| `npm create neuralis <dir>` | `<dir>` — an npm project the operator owns: its `package.json` depends on one exact `neuralis` and carries that release's `overrides` and `allowScripts` (npm reads them only there; `update` rewrites them) | `neuralis <verb>` (without the client: `npx neuralis <verb>`) |
| `git clone` of the public host repo | the clone root — the repo *is* the host package (run with Docker it cannot carry operator packages), so its `npm install` applies the release's `overrides` and `allowScripts` with nothing to copy | `neuralis <verb>` (without the client: `npx neuralis <verb>`, the package's own bin) |
| the private monorepo | `neuralis/` inside the checkout | `pnpm neuralis:<verb>` |
| the image alone (Docker, no Node.js) | the folder setup wrote from the image — `.env` and the compose files, **no `package.json`** | `neuralis <verb>` — the command the installer writes (`--install DIR` from elsewhere) |
| the desktop app (native, no Docker) | none: the app's read-only host bundle; `.env` lives in `<NEURALIS_HOME>/app/config` | `neuralis <verb>` — found through the data home's record (below) |

This page writes every command as `neuralis <verb>`: the Neuralis client (`@neuralis/cli`,
which the installer sets up) hands an operator verb to the install it finds. Confirm you are in the right folder before
running anything: its `package.json` either depends on `neuralis` (an npm install folder — the
code itself is `node_modules/neuralis`) or is the host package itself, named `neuralis` with a
`neuralis` bin. A subfolder of it works too: every verb walks up to it. Relative paths in arguments are read from the folder you typed the command
in. `login`, `logout`, `whoami`, `request`, `skill`, `package`, `device`, `mcp`, `plugin` and
`launch` belong to the client (`npm install -g @neuralis/cli`); the folder's own bin answers
them by saying so. `fs`, `agent`, `workflow`, `shells`, `git`, `source` and `connect`
are reserved for a later release.

In an image-only folder the same command line is **baked into the image**, and
`neuralis <verb>` runs it: the `@neuralis/cli` client, or where npm could not install it the
script the installer wrote (`~/.local/bin/neuralis`). It finds the install itself — `--install DIR`
(before or after the verb), else the folder you are in or above, else the one install setup
recorded in the data home; several recorded ⇒ it lists them. A folder made before 0.3.3 has no
record until its first update or `setup --compose-only`. Each verb runs in a one-shot
container of the folder's own release, as the operator's user, with the Docker socket, the
data home and the folder bound at their host paths; `upgrade`, `checkpoint restore`,
`reset-vector` and `user` run through `docker compose run` of the app service (its network
and binds); `backup` and `restore` also mount the operator's home directory at its own
path. `rebuild`, `sync`, `pkg` and `convert` refuse there by name — the folder runs the
published image as it is; a package joins it while it runs, with `neuralis package install`
(below) — and `device` needs the CLI from npm. A shell inside the RUNNING
app container cannot run any of this: the container cannot recreate itself. Say so plainly
rather than trying.

**Running these yourself requires the host-access plane** — the server running as a paired
device (`neuralis device`), `device.own` on it as its owner (`exec.device` for anyone
else's), and the target path inside that device's
ceiling. None of that can be arranged from inside the platform; it is a deliberate floor,
described in `references/host-plane.md`. Without it, report the command for a human to run
instead of attempting it.

## The first install — `neuralis setup`

In the command blocks, UPPERCASE words are the values you supply.

```bash
neuralis setup                 # wizard: data dirs, .env, compose file
neuralis setup --advanced      # the same, asking every question
neuralis setup --compose-only  # regenerate docker-compose.yml only
```

With Docker and no Node.js (Linux or WSL2), setup runs from the image into a folder
of your own, as your user, through the Docker socket. The installer does all of it in one line —
checks Docker, creates `~/.neuralis` and `~/neuralis` (`NEURALIS_DIR`), runs setup from
`neuralisapp/neuralis:latest` (`NEURALIS_TAG`), asks whether to start the stack, downloads the
desktop image in the background (log: `~/.neuralis/app/logs/machine-image-prefetch.log`) and
installs the `neuralis` command. Re-run over a folder that already holds an install, it runs no
setup: it installs the command and offers `neuralis update --apply`:

```bash
curl -fsSL https://neuralisapp.com/install.sh | sh
```

To read it first: `curl -fsSLO https://neuralisapp.com/install.sh && sh install.sh`. It needs a
terminal (setup asks questions). The manual form — what the installer runs:

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

The first line picks the release (`latest`, or a release tag); setup records the exact one in
`.env`. In the image it refuses before any prompt or write — printing that command — when
`NEURALIS_HOST_HOME` is missing, Docker does not answer through the socket, the install
folder is not bound from the host, or the data home is not writable by the user it runs as. In an image-only
folder every later run is `neuralis setup …` (`--compose-only` included). Why each flag: Why each flag:
`references/setup-and-compose.md`.

Run it **before** the first `docker compose up`, or Docker creates the data
directories first and they end up root-owned.

The compose file is a generated artifact, never hand-edited — `references/setup-and-compose.md`
covers what is in it and what regenerating does to your changes.

## The verbs

Open the row's reference before running a verb or explaining it to someone.

| You type | What it is for | Detail |
|---|---|---|
| `neuralis setup` · `--advanced` · `--compose-only` | install and configure: data dirs, `.env`, the compose file; what it writes and asks, every re-run, the config layers, a custom LLM or embedding endpoint (local runtime or keyed remote gateway), the compose file and the boot environment | `references/setup-and-compose.md` |
| `neuralis up` · `up --foreground` · `status [--json]` · `down` · `setup --native --yes …` | the desktop app's own host (native, no Docker): start, supervise, stop, a new or adopted data home, where its vectors live, one host per data home | `references/desktop-and-native-host.md` |
| `npm run build && neuralis start` | a source clone run natively, on the port `.env` names | `references/desktop-and-native-host.md` |
| `neuralis tunnel [on DOMAIN \| off]` · `setup --native --yes --lan on\|off` · `--ollama MODE` | reach it from outside (a Cloudflare named tunnel), the LAN switch, local models | `references/desktop-and-native-host.md` |
| `neuralis rebuild` | the ONLY supported rebuild; when one is required, the escalation ladder, why a rebuild "changed nothing" | `references/rebuild-and-sync.md` |
| `neuralis sync PACKAGE` · `sync status` · `--all` · `--dry-run` | swap one package into the running container without a rebuild (a DEV container); why sync refused | `references/rebuild-and-sync.md` |
| — | what the image build does, or why a package edit needs a rebuild | `references/build-pipeline.md` |
| `neuralis update [--apply]` · `--version V` · `--manifest URL_OR_FILE` · `--cli` | move the install to a release line: what moves per channel, the steps `--apply` runs, the way back, a 0.1.0 folder (below) | `references/update-and-upgrade.md` |
| `neuralis upgrade [--apply]` | raise the stored data formats, app STOPPED; what each release raises and what blocks | `references/update-and-upgrade.md` |
| `neuralis checkpoint list` · `checkpoint restore ID` | go back one build's data, app STOPPED; a missing credential key file | `references/update-and-upgrade.md` |
| `neuralis mount add HOST_PATH [--slug NAME \| --neuralis \| --pkg NAME]` · `mount list` · `mount remove …` | make a host folder visible to the container (not attached); the overlay, a package folder, a source over a folder of skills | `references/mounts.md` |
| `neuralis package list \| install NAME@VERSION \| approve ID \| restart \| update \| remove` | install a finished package into the RUNNING host — the first choice on every install | `references/own-packages.md` |
| `neuralis pkg list \| add NAME --path\|--tarball\|--version \| remove`, then `rebuild` | build a package into this install's image (npm install folder or clone); developing your own native package; a contested tool name | `references/own-packages.md` |
| `neuralis device pair \| install \| grant DIR \| status` | the host-access plane: a machine (the server too) as a paired device; why a host command was denied | `references/host-plane.md` |
| `neuralis user list \| enable EMAIL \| reset-password EMAIL` | break-glass account recovery when nobody can do it in the app | `references/recovery-and-backup.md` |
| `neuralis reset-vector` | drop the Qdrant collections — a last resort that destroys `brain://` content, not the way to change models | `references/recovery-and-backup.md` |
| `neuralis qdrant-upgrade --dry-run \| --rehearse VOLUME \| --rollback DIR` | move Qdrant one minor at a time, with a cold backup | `references/recovery-and-backup.md` |
| `neuralis backup [--out DIR]` · `backup list` · `restore DIR` | back up and restore the whole install as one consistent point | `references/recovery-and-backup.md` |

### From a 0.1.0 folder (once)

The first public scaffolder unpacked the host package INTO the
folder, and its own update command never moves the host. Convert the folder once, with the app
stopped:

```bash
docker compose stop neuralis
npx --yes create-neuralis@0.4.1 convert .   # the new layout; your .env, compose files and package lines stay
neuralis update --apply                 # the latest release: image tag + companions, then the stack steps of `update --apply`
```

What `convert` keeps, refuses and how it rolls back: `references/update-and-upgrade.md`.

### The host-access plane — `neuralis device`

These are the separate client's verbs, run on the machine itself as the user whose files the app
should reach; `neuralis host-broker` only names them now. The device's broker runs on that
machine, never in a container, and dials OUT to the app, so the container holds no host secret and
no compose bind. The allowlist ships **empty**,
which denies every host command until the device's owner names the paths it may reach — "not
configured" never means "unlimited" — and no grant ever opens the device's own sign-in and keys
to a host's file requests or to another member's commands (`device status` lists them;
`references/host-plane.md`). An image rebuild never reloads a device nor its helper: a new
client release is `neuralis update --cli --apply` (it restarts the device when the client moved;
on a current client `neuralis device install` refreshes the helper), and the end of
`neuralis rebuild` prints whether the server's helper still matches the image.

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
  in-container runner; a package for the running host goes through `neuralis package`.
- **Never pass `-f` to compose or run it from the repo root.** It makes compose skip
  the override file, and the stack comes up `healthy` with zero mounts — the single
  most recurring failure on this stack.

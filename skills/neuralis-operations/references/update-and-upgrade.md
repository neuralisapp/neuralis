# Updating, raising the data formats, and going back

## Update to a new release — `neuralis update`

```bash
neuralis update                          # plan against the latest published release line
neuralis update --apply                  # move to that line
neuralis update --version 0.2.0 --apply  # move the whole line to that version
neuralis update --manifest URL_OR_FILE --apply   # a named release line
neuralis update PACKAGE --version VERSION --apply      # one package you registered from a registry
neuralis update --json
neuralis update --cli [--apply]          # only the client itself (and a device service on this machine)
```

The client (`@neuralis/cli`, an npm global install) moves itself first: with `--apply` it installs
the newest published `@neuralis/cli` into its own npm prefix (never down) and the new client runs
the rest — the install below, then a device service on this machine restarted through `device
install` after a copy of its folder (`device/backups/<time>`, inside the protected folder). With no install folder found (a
device-only laptop), or with `--cli`, the client and the device are all that move. The script the
installer wrote and the desktop bundle's client move with the image and the app.

A release is ONE version for every package and companion image. By default the command reads
the release manifest attached to the latest public GitHub release
(`https://github.com/neuralisapp/neuralis/releases/latest/download/release-manifest.json`);
resolving each package's newest version independently would assemble a combination nobody has
ever run. A remote manifest is read over https only (a redirect off https is refused), within a
time and size bound, and must be schema 1; anything else stops the command with the reason and
moves nothing. The default line never moves an install DOWN: when the latest published release
is older than the installed host, the command refuses and names `--manifest <url|file>`, the
explicit way to choose an older line. When the release line cannot be reached, `--version` is
still the explicit path.

What moves depends on the channel:

| Channel | The code | Done by |
|---|---|---|
| npm install folder | `npm install neuralis@<version> --save-exact` — the `@neuralis/*` packages come with it, exact-pinned by the host's own manifest; the packages you registered are other lines of the folder's `package.json` and are never touched | the command (`--apply`) |
| public clone | `git fetch --tags && git checkout v<version> && npm install` | you — the command prints it and never writes into a checkout |
| image-only folder | the image tag (`docker pull` of the new release first; a failed pull moves nothing) | the command (`--apply`), run as `neuralis update` |
| development checkout | `git pull`, `pnpm install`, `pnpm neuralis:rebuild` | the command refuses |

`npm update` cannot do this job: the folder pins `neuralis` exactly (so `npm update` is a
no-op), and `npm install neuralis@latest` without `--save-exact` rewrites the pin into a range —
silently turning a tested release line into "whatever resolves today". A package name limits the
run to one package you registered from a registry (`pkg add --version`), at the exact `--version`
you give; the `@neuralis/*` packages always move with the line, never one by one.

The container runs the image the `.env` `NEURALIS_IMAGE_TAG` names, at that exact tag — never a
moving one. A release `--apply` moves that tag to the line's `neuralisapp/neuralis` version and
moves the companion images the install pins to the release default — `.env`
`NEURALIS_MACHINE_IMAGE` and the platform settings `machineImage` / `mcpSidecarImage` when they
hold a `neuralisapp/<image>:<tag>` value — and leaves any other image (a custom build, another
registry, a digest pin) exactly as it is, naming it in the output. On an npm install folder those
moves run in the code just installed: the command re-runs the new `neuralis` bin once npm
install succeeded, so the old code never performs a step of the new release; an image-only folder
re-runs it in the new image the same way. A folder already on the line's code (after a
conversion, or an interrupted run) still moves its tag.

**On an npm install folder and an image-only folder `--apply` then finishes the update itself**, in the new code:
regenerate compose (`setup --compose-only`), stop ONLY this install's app, start the vector store
if it is down (never stop it — the upgrade reads it), `upgrade --apply` (the stored data formats
the release needs; nothing to do is fine), recreate with **`docker compose up -d -V`** — or
`neuralis rebuild` when the folder registers packages of its own (its derived image over the
new release) — and wait up to 5 minutes for `/api/health` to answer ready. It knows what to act on
from the folder: the compose project from `.env` `NEURALIS_COMPOSE_PROJECT`, the app and vector
store from the compose file's `neuralis.kind` labels, the port from `NEURALIS_APP_PORT`; every
compose call runs in the folder with no `-f`. The first failing step stops it — a refused boot
names the health code (`upgrade_required`, …) — and it prints where it stopped, what already ran,
the commands left and the way back. Without `--apply` it prints that plan: the folder, the
project, both services and whether they run, the image tag. It refuses before moving anything when
the app answers on its port but no compose service of the folder runs it (a process outside
compose would keep serving the old code). The `-V` is load-bearing — without it the anonymous
volumes mask the new image-built runtime and the update appears to do nothing.

**A clone runs those steps by hand**: `neuralis setup --compose-only`,
`docker compose stop neuralis`, the upgrade, `docker compose up -d -V`.

The way back, which the command prints — data first, because an older build refuses to boot on
data a newer one raised:

- **data** — `docker compose stop neuralis && neuralis checkpoint restore <id>` (`neuralis …` in
  an image-only folder), the checkpoint the upgrade took (`update --apply` prints its id; restore
  runs only with the app stopped);
- **code and images** — `neuralis update --version <previous> --apply`: a named version may
  move down, and the command moves the images and restarts the app itself. A published version is
  immutable, so the previous one is always installable. A clone: `git checkout v<previous> &&
  npm install`, then the images with `neuralis update --manifest <the previous
  release-manifest.json> --apply` or the previous `.env` lines by hand.

## From a 0.1.0 folder (once)

The three commands — stop the app, `convert`, `update --apply` — are on the skill's main page. What
`convert` records the old manifest, lock and tarball file list, writes the new `package.json`
(every dependency line you added — a registered package, a `file:` path — carried verbatim),
installs, then deletes exactly the files the 0.1.0 package shipped, behind a checkpoint in the
folder's `checkpoints/` (it prints the path; the old tree rides in it as one archive, so the system
`tar` is needed, as for the 0.1.0 install); `.env`, `.npmrc`, both compose files and anything
the old package did not ship are never touched. A natively run folder (a `.next/` build) is refused
with nothing written — native runs move to a source clone. A refusal before the checkpoint (the app
still answering) puts `package.json`, the lock and `.npmrc` back and reinstalls the 0.1.0 tree; a run
stopped after it resumes when re-run; a converted folder is left alone. Going back: `neuralis convert --rollback <id> && rm -rf node_modules && npm install`
restores the 0.1.0 folder. A host-broker unit written before the conversion runs the old broker —
replace it once with `neuralis device install` (`host-plane.md`).

## Raise the stored data formats — `neuralis upgrade`

```bash
neuralis upgrade            # dry run: what would change; writes nothing
neuralis upgrade --apply    # app STOPPED: one checkpoint, then every pending upgrade
```

Some record kinds are never raised by the running app: an ID or layout change to stored
data is a one-shot upgrade on a **stopped** app, never a converter inside the runtime. A build
that meets such a kind behind its code version — or an upgrade that was interrupted — refuses
to start and names this command (`upgrade_required`). The order after an update is therefore
`docker compose stop neuralis` → `neuralis upgrade --apply` → `docker compose up -d -V`
(`neuralis rebuild` where the folder builds, and says before it builds when the new build has
such a kind pending; on an npm install folder `update --apply` runs all three; the desktop app's
host: quit the app or `neuralis down` → `neuralis upgrade --apply` → `neuralis up`) → on a server that had the host broker, `neuralis device install` there, and "nothing
to do" is a normal answer. The release that brings paired devices raises
`agent-core/device-registry` and `neuralis/project`
(`source-device-v1`; the host-source format it also raised is retired by the folder merge below): it registers the server's broker as the operator device from the secret it
already holds and writes `~/.neuralis/device/device.json` (`neuralis device install` — or `device run` —
on the server then moves it into `device/hosts/<hostKey>/`, writes the local socket's own secret and
adopts it without pairing again), stamps that device into every host source and host background shell, and gives
`device.own` to the stored builtin roles the manifests grant it. Its owner is the ONE user the
host sources name; when they name none or several, the dry run asks for
`NEURALIS_DEVICE_OWNER=<userId>`, and a host source with no broker secret on the machine blocks —
run it on the server (on an image-only server `neuralis upgrade --apply` binds the data home's
`host-broker` and `device` folders into its one run of the app service; the running app binds neither). The release that gives the feature ids
their two-word names (`files.*`, `sources.*`, `exec.local`, …) raises `neuralis/project` once more
(`two-word-features-v1`: every stored role, custom ones included, takes the new ids; a role that
held the removed host-mount feature without `device.own` is named in the dry run and does not gain
it) and `neuralis/platform-config` (`platform-config-v2`: the retired host-broker address keys
leave `platform.json`). The release that lets a native host and the Docker image share one data
home raises `brain-core/source-config` (`source-root-pair-v1`): every local source whose absolute
root has only one half of its root pair gets the other — a container path (`/.neuralis/…`, a mount
with a known host folder) its machine path, a machine path under the data home its container
spelling — so a source attached on one side opens on the other; a root no table maps (an image
path, a mount without a host folder) is kept and named in the dry run, and a pair that disagrees
with the derivation is listed and never rewritten. The release that makes every folder ONE `folder`
source raises `brain-core/source-config` to v4 (`source-to-folder-v1`): a local source becomes a
folder on this server, a host source a folder on its device, and `recognizesPackages: true` becomes
`packageFolders: ['']`; a host source that names no paired device, or carries a host folder beside
its device, blocks and is named — remove or re-attach it in the running older build first. The release that spells that kind `host` raises it to v5 (`source-to-host-v1`, every root, host folder and device kept as it was) and, in the same run, `agent-core/conversation-messages` and `agent-core/shell-run` to v2 (a stored `plane: "host"` — where a past command ran — reads `plane: "device"`); nothing blocks it. The release that names the plane refusals by the same words raises `agent-core/conversation-messages` to v3 (`stored-device-codes-v1`: a stored `host_plane_denied` reads `device_denied`, `container_plane_denied` `local_denied`, `host_plane_disabled` `devices_disabled`; a code quoted inside text stays) and `neuralis/project` to v5 (`written-role-agents-v1`: a stored role that names no agent level takes one — a builtin role its builtin level, any other role `own`). The release that names path-rule subjects by strength raises `brain-core/source-config` to v6 (`source-uri-subject-v1`): every stored owner/admin grant row takes `priority` (the caller's role priority, n or stronger: 2 when admin is named, 1 for owner alone), rows naming a project role stay as they are; app stopped, a second run writes nothing — the desktop app's host runs it by itself (`up` exits 12, the app runs `upgrade --apply` once and starts again). The release that makes every agent private to its creator raises `brain-core/source-config` to v7 and `agent-core/agent` to v3 (`source-use-grants-v1`): each project's data policy takes the private-agent rows right after its first agent-folder write row, never at the end; a user who was assigned to an agent, or who holds a conversation with it, and is still a member keeps using it through one read row on the agent's record, appended last; a record loses `visibility`, an empty name takes its slug, and an MCP key is stamped with its creator as the minter; empty legacy `git-oauth`/`mcp-oauth` pending folders are removed. A data policy without that agent-folder write row, or with a stored user or strength read grant before it that the new rows would clear, blocks and is named in the dry run; a second run writes nothing. The move from 0.1.0 to this release raises `neuralis/credential` (a check: it
names every credential the key file cannot open and writes nothing) and `brain-core/vector-proof`,
which reads Qdrant — so Qdrant must be RUNNING while the app is stopped; the release that adds
the `@neuralis/cli` sign-in raises `agent-core/oauth-tokens` (`oauth-resource-v1`: every stored
OAuth grant is stamped with the MCP resource it was issued for, none is dropped, so connected MCP
clients keep their sign-in — skip it and the app refuses to start with `upgrade_required`): stop only the app
(`docker compose stop neuralis`), never `down`. The vector-proof step marks every vector point
once with its embedding proof (no re-embed); the vector database is busy for a few minutes on a
large index, and the command prints `<marked> / <total>` every 10 000 points. Both modes refuse while the app answers on its port (on a native install that loopback health
probe is the whole proof of a stopped app — it is not process exclusivity). `--apply` takes ONE
checkpoint of every file the pending upgrades touch plus the ledger, marks the ledger
`upgrading`, runs each upgrade, and clears the mark last; re-running the same command resumes an
interrupted run without a second checkpoint, and a completed run writes nothing. Going back is
the checkpoint's job (below). The dry run ENUMERATES what blocks an apply: a package source the
host cannot see is named with its project, source and root (on the machine a mounted source's
container root is translated through the compose override's `NEURALIS_MOUNT_<slug>` /
`NEURALIS_MOUNT_HOST_<SLUG>` pair; no pair ⇒ `neuralis mount add <host-folder> --slug <slug>`
or clear "recognizes packages" on that source), and the reference census is printed in full: `Dropped` (a trust, grant, override or
disable key whose package no instance in the complete inventory carries — trust is never inherited
by name, so these are removed and the checkpoint keeps the original), `Merged` (two spellings of one
package in one map with identical values become one entry), and `Blocking` (a still-running
delegate's reference, a key no rule covers, two spellings with DIFFERING values, an orphan data
zone) with the record file, field and the way out. The data-zone upgrade's `zones:` line counts the
`data/_installed/` zones moved to `data/runtime/…` and those left to the identity upgrade (it runs
first); a zone with no identity marker and no installed package of its name, or a pre-project
`projects/{agent-core,brain-core,terminal,_installed}` folder with no such project, blocks — move it
out of the data root (the backup folder keeps it). An apply refuses while anything blocks; a
finished delegate run's record and a removed builtin's provenance never block (they pass through
verbatim). In an image-only folder it is `neuralis upgrade --apply`, run in the app's compose
service between `docker compose stop neuralis` and `docker compose up -d -V`.

The release that moves the session secret into the data home raises `neuralis/session-secret`
(`session-secret-v1`): it writes `app/config/session-secret.key` from the `.env` `NEXTAUTH_SECRET`
the command loads (an image-only folder's app service gets it through `env_file`), so nobody is
signed out, and blocks when users exist but the secret is in neither place, or when the file and
the `.env` disagree (the file is never overwritten — keep the one users last signed in with). The
leftover `.env` line is read by no build and no boot (an un-regenerated compose file still passes it
into the container); `update --apply` and a full `setup` drop it. By hand, run
`neuralis setup --compose-only` before deleting it: a compose file an older setup wrote still
requires the line and stops every compose command, `down` included, without it.

Inside a container the checkpoint lands on the host only because the compose file binds
`<NEURALIS_HOME>/checkpoints`; an apply refuses while that folder is the container's own writable
layer (a compose file generated before the bind) and names the one-run fix, `-v <NEURALIS_HOME on
the host>/checkpoints:/.neuralis/checkpoints`.

## Go back a version — `neuralis checkpoint`

```bash
neuralis checkpoint list            # checkpoints, newest first, and the data-format ledger
neuralis checkpoint restore ID    # app STOPPED; asks for the id again
```

Every build records which on-disk format of each record kind it reads and writes, in
`<NEURALIS_HOME>/app/config/data-formats.json`. The running app never raises a format and never
takes a checkpoint: a build that meets a kind behind its code version refuses to start and names
`neuralis upgrade` (`upgrade_required`), and that command takes the checkpoint before it
writes, into `<NEURALIS_HOME>/checkpoints/`. After a completed apply it keeps the newest
`dataCheckpointKeep` (Admin → Config, default 5) and removes the older ones. When a build meets
data **newer** than it reads, it does not start: the boot error names the record kind, both
versions, the newest checkpoint and this command.

`restore` refuses while the app answers on its port or `docker compose ps` shows the
`neuralis` service running — stop it first (`docker compose stop neuralis`). Everything
written after the checkpoint is lost, which is why it asks for the id again. In an image-only
folder it is `neuralis checkpoint restore ID`, run in the app's compose service.

A missing `credential-master.key` or `credential-salt.bin` beside encrypted credentials stops
every credential read and write with a refusal naming the file — the store never derives a key
from the session secret or a static salt, and never generates a new file over existing
credentials. Put the file back from a backup, or restore a checkpoint that carries it;
`neuralis upgrade` names every credential the key file cannot open. A checkpoint is a way
back one build, not a backup. A build from before the session secret moved into the data home
reads it from `.env` only: going back to one, put `NEXTAUTH_SECRET=<the line of
app/config/session-secret.key>` back into `.env` first.

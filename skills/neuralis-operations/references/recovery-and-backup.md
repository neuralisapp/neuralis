# Account recovery, the vector layer, the Qdrant upgrade, backup and restore

## Recover a locked-out account — `neuralis user`

```bash
neuralis user list                     # every account and its status
neuralis user enable EMAIL           # re-enable a disabled account
neuralis user reset-password EMAIL   # print a one-time temporary password
```

For when nobody can do it in the app: every owner disabled, or the only owner's
password lost. The host shell is the boundary, so it asks no credentials; each change
is confirmed by typing the address again and audited under the operator's OS user
name. A reset forces a new password at login and refuses every earlier sign-in and
every earlier MCP client token at its next use. The command runs outside the app
process, so it closes no connection already open — live updates, terminals, desktop
streams, a running turn: those stay until `docker compose restart neuralis` in the host
folder (it only bounces the process; a device-plane terminal ends with its device's broker). A
reset made in the app closes them at once. An enable resumes nothing that paused
meanwhile. It never disables or deletes — those stay in the app.

## Reset the vector layer — `neuralis reset-vector`

```bash
neuralis reset-vector
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

## Upgrade Qdrant — `neuralis qdrant-upgrade`

```bash
neuralis qdrant-upgrade --dry-run            # the hop chain; changes nothing
neuralis qdrant-upgrade --rehearse VOLUME  # the whole chain on a CLONED volume
neuralis qdrant-upgrade                      # the real run: stops the stack
neuralis qdrant-upgrade --rollback DIR     # restore a run's cold backup
```

Qdrant's on-disk format is **forward-only** and upgrades **one minor at a time**, so
the version a deployment runs is recorded install state
(`<NEURALIS_HOME>/qdrant-version.json`), and the compose file runs exactly that version,
digest-pinned. Setup refuses, in docker and binary mode, when the recorded version is more
than one minor behind the shipped one, and names this command — an existing install meets
it at the first `--compose-only` after the update (`neuralis rebuild` runs that step itself
before every build). Never edit the compose
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

## Back up and restore the whole install — `neuralis backup` / `neuralis restore`

```bash
neuralis backup                              # stops the app + Qdrant, copies, starts them again
neuralis backup --out DIR                  # default: HOME_DIR-backups/TIME, beside the home
neuralis backup --include-volume NAME      # also a snapshot / desktop-profile / Ollama volume
neuralis backup list                         # complete backups, newest first
neuralis restore DIR                       # app STOPPED; asks for the folder name again
neuralis restore DIR --home TMP_HOME --volume CLONED_VOLUME   # into a throwaway target
```

A backup is one consistent point: `<NEURALIS_HOME>` (`app/` with the credential master key,
`projects/`, `checkpoints/`, `device/` (a server's device; `host-broker/` before its `device install`), `qdrant-version.json`, and in binary Qdrant mode
`qdrant-storage/` — minus `qdrant-backups/`, the upgrade's own rollback tars), the
`<project>_qdrant-data` volume — **primary data, not a rebuildable index: `brain://` content
lives only there** — the install folder's `.env` (it sits outside the home and carries
`QDRANT_API_KEY`, without which the restored volume answers no client, and the stack's ports and
addresses; the session secret is inside the home) and `docker-compose.override.yml` (the mounts).
Snapshot exports, `neuralis-machine-*` desktop profiles and `ollama-data` are named and left
out unless `--include-volume` asks for them. It refuses before stopping anything without the
`.env`, without the free space, or with a folder inside the home, the install folder or the repo (a
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
volume and never touch the live ones. Afterwards always run `neuralis setup --compose-only`
(the restored `.env` names the image tag and the Qdrant mode the backup was taken on;
`neuralis setup --compose-only` in an image-only folder), then `docker compose up -d -V`. Never
`down -v` on the way.

In an image-only folder both are `neuralis backup …` / `neuralis restore …`; their one-shot
container also mounts the operator's home directory at its own path, as that user, so the
default `<home>-backups/` folder and the `.before-restore` copies land on the host.

Going back one build is the checkpoint's job (`update-and-upgrade.md` §Go back a version), not this one's. An installed
compose file runs the exact tag `.env` `NEURALIS_IMAGE_TAG` names, so the previous release
stays addressable by its tag — rolling the image back is writing that tag back. Role grants never change at runtime:
a raise ships as an offline module that raises the `neuralis/project` data format, so `neuralis upgrade
--apply` checkpoints before it and an older build refuses to start — naming the record kind and the
checkpoint command — instead of serving the project read-only. Builds older than the
data-format ledger have no such guard: the first published beta is the floor of a safe rollback.

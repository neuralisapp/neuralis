# Filesystem mounts

## The commands

```bash
neuralis mount add HOST_PATH [--slug NAME] [--project ID]   # a data source
neuralis mount add HOST_PATH --neuralis [--with-docker]         # the /neuralis overlay
neuralis mount add HOST_PATH --pkg PACKAGE_NAME               # a package folder
neuralis mount list [--project ID]
neuralis mount remove SLUG [--project ID]
neuralis mount remove --neuralis
neuralis mount remove --pkg PACKAGE_NAME
```

Without `--project`, `list` shows every project's attachments and `remove` checks every
project's source configs for references — a mount is instance-wide.

## Mounting is not attaching

`neuralis mount add` writes **infrastructure**: a bind mount plus the environment
pair that lets the runtime describe it. It does not create a source, and agents cannot
reach the folder yet. Three steps, in order:

1. `neuralis mount add <host-path> --slug <name>` — writes the bind and env pair.
2. Restart so compose applies it (`docker compose up -d`; `-V` is not needed unless the
   overlay itself was added or removed).
3. Attach it as a filesystem source from the Files UI, choosing its scope.

Skipping step 3 is the usual "I mounted it and nothing appeared". After step 2 the
folder is visible to the container and appears in the agent's runtime-stack block as a
host-path label — a hint that something is mountable, not a callable scope.

## Where it is written

Everything goes to `docker-compose.override.yml`, machine-local and never committed. It
adds, per mount, a bind and two environment variables: one giving the container path,
one recording the host path so the discovery UI can show where a mount came from.

The base compose file is **mount-immutable** — regenerate it as often as you like, the
override survives. That is the entire reason for the split.

## The `--neuralis` overlay

Binds the host's own Neuralis folder onto `/neuralis` inside the container. The
image-built runtime and the installed packages survive it — both sit behind anonymous
volumes precisely so a whole-folder overlay cannot shadow them — so what the overlay
actually replaces is the *source-shaped* part: `scripts/`, `skills/`, `src/`, config.

Two consequences worth stating:

- The `neuralis://` source shows the **live host folder** rather than what the image
  baked. Without the overlay that path still exists and still resolves, showing the
  baked copy — which is why a pulled image can read its own operator skills with no host
  folder at all. Only the Discover *suggestion* is overlay-gated; the content is there
  either way, and a hand-typed source reaches it.
- The overlay binds onto the container WORKDIR, so its root holds `.env`. What Discover offers over it,
  and why the narrow proposal is not just tidier: §A source over a folder of skills, below.
- Script edits under `scripts/` apply immediately, because they run through `tsx` at
  invocation. Host application code does **not** hot-reload; that still needs a rebuild.

`--with-docker` additionally binds the Docker socket. Treat that as a privileged host
capability: anything that can reach the socket can control the daemon.

## Package folders

The live-edit lane for a package already registered and installed. The folder is BOUND
onto `/neuralis/node_modules/<name>` — over the copy the image installed — so discovery,
CJS `require` and ESM `import` find it exactly where they found that copy. Its own
`node_modules/` is masked by an anonymous volume that starts from the dependencies the
image deployed for the package, so it resolves the image's ONE kernel and ONE React and
never a dev checkout's links. The tool pre-creates the mask's mountpoint as you, so Docker
never creates it as root inside your folder. It also writes the `/mounts/<slug>` bind and
its host pair, for a source rooted at the folder. A name that is not a host dependency is
inert until `neuralis pkg add` registers it (the tool says which case you are in) —
see `own-packages.md`.

**`--pkg` and a plain data mount are not alternatives, and `--pkg` does both jobs:** the
`/mounts/<slug>` bind it writes carries its `NEURALIS_MOUNT_<slug>` / `NEURALIS_MOUNT_HOST_<SLUG>`
pair. That pair is not decoration: it is how a source rooted at the mount derives its
host path. Without it the operator has to type `hostRoot` into the source by hand, an
explicit value wins over every derivation, and a wrong one persists with nothing
validating it. You cannot get the pair by running a data mount over the same slug
afterwards — both add forms refuse a container path that already exists. **A mount slug
may contain `-`, and the metadata names normalise it to `_`** (`my-pkg` →
`NEURALIS_MOUNT_HOST_MY_PKG`); the two sides agree, so do not "fix" one of them.

An override written by an older host may still carry a `NEURALIS_PKG_LINKS` line and a
`NODE_PATH` fallback. Nothing reads either; `mount add <dir> --pkg <name>` gives that folder
its bind.

## Removing

Removing the last machine-local mount deletes the override file entirely (the tool
prints "no machine-local mounts remain") — the base compose file needs no override to
run, and an empty generated file would only invite hand-edits.

A removed mount leaves its attached source behind, now pointing at nothing. Detach it
from the Files UI too, or it reports as errored — per-source isolation means only that
one row breaks, not the whole drive.

**`mount remove --pkg <name>` alone leaves the package registered.** It drops both binds,
the mask and the host pair; the dependency line survives it, and the next start loads the
image's installed copy. `pkg remove` takes out both the line and the mount.

## A source over a folder of skills

**A source over a folder of skills is a discovery mechanism, not just access.** A directory
containing a `SKILL.md` is treated as a package root, so attaching a read-only source over the
deployment's `skills/` folder makes each one a *discovered source package* that reaches an agent's
context by itself, instead of a file someone has to know to open. Root it at the skills folder and
**never at the deployment root** — that directory holds the `.env` carrying the session secret and
the vector-store key, and a source there would put both into agent reach and into the vector index.

With the overlay configured, Files → Discover offers this ready-made, narrowest first:

- **Neuralis Skills** — rooted at `neuralis-tree:skills` (the tree's `skills/` on whichever plane
  opens it: the overlay here, the host's own folder on a native install), user-scoped, manual sync, and read-only via a
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

# Filesystem mounts

## Mounting is not attaching

`pnpm neuralis:mount add` writes **infrastructure**: a bind mount plus the environment
pair that lets the runtime describe it. It does not create a source, and agents cannot
reach the folder yet. Three steps, in order:

1. `pnpm neuralis:mount add <host-path> --slug <name>` — writes the bind and env pair.
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

```bash
pnpm neuralis:mount add <host-folder> --neuralis [--with-docker]
```

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
- The overlay binds onto the container WORKDIR, so its root holds `.env`. Discover offers
  two proposals accordingly: **Neuralis Skills** rooted at `<overlay>/skills` (manual, shown
  only when that folder exists, and read-only through an explicit `**` write/exec deny) and
  **Neuralis Tree** over the whole folder, which pre-fills a skills-only sync `include` plus
  denies on `.env*` (read and write) and on writing `Dockerfile`, `docker/**` and every compose
  file the daemon would pick up — `rebuild` runs `docker compose up` with no `-f`, so an
  override beside the base is merged and a bare `compose.yaml` replaces it, `.yml` and `.yaml`
  alike. Prefer the first unless you are editing platform source. Two reasons the
  narrow one is not just tidier: a sync `include` bounds the index, not what `fs_read` can
  reach, and a source attached at user or agent scope grants its creator write+exec
  regardless of the access you pick in the form — only a path rule takes that back.
- Script edits under `scripts/` apply immediately, because they run through `tsx` at
  invocation. Host application code does **not** hot-reload; that still needs a rebuild.

`--with-docker` additionally binds the Docker socket. Treat that as a privileged host
capability: anything that can reach the socket can control the daemon.

## Package folders

```bash
pnpm neuralis:mount add <dir> --pkg <name>
```

The live-edit lane for a package already registered and installed. The folder is BOUND
onto `/neuralis/node_modules/<name>` — over the copy the image installed — so discovery,
CJS `require` and ESM `import` find it exactly where they found that copy. Its own
`node_modules/` is masked by an anonymous volume that starts from the dependencies the
image deployed for the package, so it resolves the image's ONE kernel and ONE React and
never a dev checkout's links. The tool pre-creates the mask's mountpoint as you, so Docker
never creates it as root inside your folder. It also writes the `/mounts/<slug>` bind and
its host pair, for a source rooted at the folder. A name that is not a host dependency is
inert until `pnpm neuralis:pkg add` registers it (the tool says which case you are in) —
see `own-packages.md`.

An override written by an older host carried a `NEURALIS_PKG_LINKS` line and a
`NODE_PATH` fallback; any `pnpm neuralis:mount` run, `list` included, rewrites it to binds
and says so.

## Removing

```bash
pnpm neuralis:mount list
pnpm neuralis:mount remove <slug>
pnpm neuralis:mount remove --neuralis
pnpm neuralis:mount remove --pkg <name>
```

Removing the last machine-local mount deletes the override file entirely (the tool
prints "no machine-local mounts remain") — the base compose file needs no override to
run, and an empty generated file would only invite hand-edits.

A removed mount leaves its attached source behind, now pointing at nothing. Detach it
from the Files UI too, or it reports as errored — per-source isolation means only that
one row breaks, not the whole drive.

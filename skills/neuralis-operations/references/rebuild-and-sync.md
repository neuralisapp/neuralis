# Rebuilding, syncing, and "I rebuilt and nothing changed"

## Rebuild the image — `neuralis rebuild`

```bash
neuralis rebuild               # the ONLY supported rebuild (`pnpm neuralis:rebuild` on the development checkout)
```

What it builds is what the regenerated compose file says. The development checkout builds the
whole image. An npm install folder whose `package.json` registers packages of its own (`pkg add`)
builds ONE derived image of this install — the release image `NEURALIS_IMAGE_TAG` names plus those
packages, named `neuralis-<project>:<tag>-<hash>` and built from the `operator-image/` context setup
writes beside the compose file — and with none it builds nothing and recreates the stack on the
release image. An unchanged set builds from cache; the derived image builds again only when the
set, a `file:` source or the release tag changes (the run prints which image it is).

Never substitute a raw `docker compose` invocation. The wrapper regenerates the compose
file (the build's local packages and private-registry secret are derived from it), runs the
load-bearing `up -d --build -V` from the right directory with no `-f` flag, prints what the
build refused, and performs bounded cache cleanup. Each step is load-bearing and skipping
one has caused real outages — the next section.

The same run keeps the managed MCP sidecar image (`neuralisapp/mcp-sidecar:<version>`, the host's own version — the tag the platform spawns) current,
but only when there is a reason — the image is missing or its source-hash label differs from
`packages/agent-core/docker/mcp-sidecar/` — so an unchanged sidecar costs one line and no
build; `--no-sidecar` skips it, a failed sidecar build is reported and never fatal, and an
installed tree (no `docker/`) skips it by name. The desktop image stays a separate build.

**An agent whose shell runs INSIDE the platform container cannot run this**, and that
holds even when the install folder is visible at `/mounts/repo` and the Docker socket is
reachable: the command would replace the very container the shell lives in, and the
container's Docker CLI carries no BuildKit plugin, so the build dies partway with
`--mount option requires BuildKit` while the running container is never recreated.
Report the command for the host operator to run and say plainly that you cannot;
polling a build that structurally cannot succeed is the failure mode this sentence
exists to prevent.

## Why `neuralis rebuild` and not a raw compose command

The wrapper exists because three details of the correct invocation are impossible to
remember and expensive to get wrong.

**It regenerates the compose file first.** The build's inputs — one named context per
registered local package, the build lock kept for them, the private-registry `.npmrc`
secret — are derived from this machine at that moment, so a `pkg add` or `pkg remove`
takes effect at the next rebuild with nothing else to run. A registered folder that no
longer exists or an unusable `.npmrc` stops it here, named, before Docker runs. A raw
`docker compose up --build` builds with whatever the last regeneration wrote.

**It runs from the host folder with no `-f` flag.** Compose merges
`docker-compose.override.yml` only under exactly those conditions. Pass `-f`, or run
from a parent directory, and the merge is skipped — the container comes up **`healthy`
with zero mounts**. Nothing errors. The override file still looks perfect on disk, so
re-adding the mount does not help either: the file already contains it and the re-add is
a no-op. The only fix is to run the rebuild the right way.

Thirty-second diagnosis when a source "disappears":

```bash
docker inspect "$(docker compose ps -q neuralis)" --format '{{range .Mounts}}{{.Destination}}{{println}}{{end}}'
```

If nothing under `/mounts` is listed, the override never merged.

**It passes `-V`.** The image protects its build output behind two anonymous volumes —
one on `_runtime/`, one on `node_modules/` — so that bind-mounting a host folder over
the working directory cannot shadow them. Without `-V` those volumes are *reused*, and
the freshly built image is masked by the previous build's contents. This is the single
most common cause of "I rebuilt and the behaviour did not change".

**It cleans up afterwards, within bounds.** Only after a green build: prune anonymous
dangling volumes (never `--all`, which would take named ones), trim the build cache to a
warm-cache target, then **measure** what Docker reports and apply a stronger prune if it
is still over the hard limit. The measurement is the point — a cleanup that trusts the
prune flags without re-reading the total has been observed to leave the cache far above
its supposed ceiling. A failed build cleans nothing and exits with the build's own code.

## When a rebuild is required

| You changed | Action |
|---|---|
| any package source, manifest, skill or tool; a package registered or removed | **rebuild** — the runtime reads baked `node_modules` |
| package UI classes | nothing extra — the package's own rebuild or sync carries its `app/` sources, and the host compiles ONE package stylesheet from them when it loads the package set |
| host `src/` | **rebuild** — the runtime serves a standalone build |
| dependencies, Dockerfile, lockfile | **rebuild** |
| `docker-compose.override.yml` (a mount) | `docker compose up -d` — recreate, no build |
| `.env` | regenerate compose, then `up -d` |
| `~/.neuralis` config or credentials | nothing — read live |
| the server device's confinement helper (every rebuild produces a fresh one in the image) | `neuralis device install` on the server (a rebuild moves the image's helper, not the client; `neuralis update --cli --apply` restarts the device only when a newer client is published) — a device never follows a rebuild by itself; `neuralis device status` and the end of `neuralis:rebuild` print the drift |

Three facts are **computed at image build and frozen**: the host's own generated CSS, the
list of packages kept out of the server bundle, and every `NEXT_PUBLIC_*` value. No runtime
environment variable can change any of them.

`docker compose restart` only bounces the process; it applies no compose, environment or
image change. Prefer `up -d`.

## Escalation ladder

Escalate in order; never jump to the bottom.

1. `docker compose up -d`
2. `docker compose up -d -V` (recreate, renew anonymous volumes)
3. stop → `rm -f -v` **that one service** → `up -d` (drops only its anonymous volumes;
   the vector data lives on a different service and is untouched)
4. `docker builder prune`, then `neuralis rebuild` — never a raw `docker compose build`, which skips the compose regeneration the wrapper does first
5. stop and work out what is actually wrong

`down -v` is not a step on this ladder. It destroys the vector store.

Then **prove** the rebuild landed. `docker compose ps` reporting `healthy` says the
health endpoint answered, not that your change is in there. Check the artifact:

```bash
docker compose exec neuralis grep -rl 'A STRING FROM YOUR CHANGE' \
  /neuralis/node_modules/PACKAGE_NAME/dist/
```

And read the end of the rebuild's output: it names every UI module and package the build
refused (`UI module refused`, `package refused`) — the platform runs without them.

## Swap a package without rebuilding — `neuralis sync`

```bash
neuralis sync status           # what diverges from the container; changes nothing
neuralis sync my-package       # rebuild + swap that package (~1 min vs ~6–10)
neuralis sync @acme/my-package # the full registry name works too
neuralis sync --all
neuralis sync --dry-run        # the whole plan, no writes
neuralis sync --no-restart     # swap but leave the process alone
neuralis sync --json
```

This is the fast inner loop for **developing your own native package**. What is syncable, and how a
local folder builds: `own-packages.md` §What makes a package syncable.

**A synced container is a DEV container.** A full `neuralis rebuild` is still
required before any deployment judgement; sync writes a divergence marker so that rule
is checkable rather than remembered. Every refusal it prints is a case where the swap
would produce a container that looks updated and is not — never argue with one, and
never work around it.

## What `neuralis:sync` refuses, and why each refusal is right

Every one of these is a case where the swap would produce a container that looks updated
and is not. They are errors, never warnings.

| Refusal | Why |
|---|---|
| the kernel package | it is compiled **into** every dependent's build output, so swapping it alone leaves them all on the previous contract |
| a `files` entry no rule classifies | deny-by-default: an unclassified entry could be anything, including something that must not be swapped live |
| no `files` whitelist at all | packing would ship the entire directory, sources and tests included |
| a path that reaches no tarball | host-resident tooling, or sources baked into a *different* image — swapping the main one changes nothing |
| the target is still bundled into the server chunks | replacing `node_modules` would update only half the process, with no error anywhere |

That last one is the invariant the whole tool rests on, so it is re-checked per package
rather than assumed. See `build-pipeline.md`.

**The unclassified-entry refusal is right, but its classified SET is hand-maintained and
drifts.** It is the package contract's own discovery surface — `dist` plus every folder
`PackageFileDiscovery` scans at the package root — and it is enumerated by hand in
`scripts/sync.mts`, so a legitimate contribution folder that nobody added to the list makes
its package permanently unsyncable. That is not hypothetical: `docs` (one of the five file
categories) was missing, so **brain-core could never be synced at all** and every brain fix
cost a full ~6–10 min image rebuild until 2026-08-18. If sync refuses a native package
over a category folder, the answer is to classify it, not to rebuild forever — and the real
fix is deriving the set from the discovery scanner instead of restating it.

**Sync builds before it compares.** The divergence check reads the built output, and a
source edit does not touch that until something compiles it — so a check-first ordering
would answer a question about the previous build and report "nothing to sync" for
precisely the case you invoked it for. `status` and `--dry-run` deliberately do not
build: both promise to change nothing. A workspace package builds with its dependents; a
local folder builds in its own root, and a folder bound over its installed copy
(`mount add --pkg`) is not swapped at all — the restart loads it.

## Fingerprints

| Symptom | Cause and fix |
|---|---|
| rebuilt, behaviour unchanged | anonymous volumes reused → rebuild with `-V` |
| every mounted source gone, container healthy | the override never merged → rerun from the host folder with no `-f` |
| a package UI's unique styling silently vanished | the class lives outside the package's `app/` tree, which the package stylesheet never scans → move it under `app/`; or the log says `Union stylesheet not compiled` |
| container unhealthy for over two minutes | read the logs; the health endpoint surfaces the bootstrap failure phase in its body |
| a package injected by sync survived a plain recreate | that is expected — sync writes into the container's tree; only a rebuild with `-V` restores the image's |
| a desktop image change had no effect | it is a **separate image** and a host rebuild does not build it |
| a package's widgets show *"This widget cannot be rendered by this host."* after an upgrade | its UI module was refused — the placeholder, Admin health `ui-modules` and the rebuild's output name the reason; `react-major` / `host-api-version` mean the module predates this host → its owner rebuilds it with `neuralis-build ui` (`build:ui`); `no-install-export` means its entry exports no `install<Name>HostComponents` |
| a registered package is missing, the rest runs | the build or the start refused it — the rebuild printed `package refused`, Admin health `builtin-packages` names it, `/api/health` counts it (`refusedBuiltins`) |
| the rebuild stops before Docker: `the build inputs are not usable` | a registered folder or tarball is gone (restore it, or `pkg remove` it), more than eight local packages, or `NEURALIS_BUILD_NPMRC` names a missing file / carries a default `registry=` line |
| the build (or `pkg add`) stops naming a scope and `NEURALIS_BUILD_NPMRC` | a dependency is in a scope seen served privately (`<NEURALIS_HOME>/build/private-scopes.json`, a lock or a manifest) that the `.npmrc` does not route — add the scope line, or delete the scope's entry from that file if it is public now; nothing was asked of the public registry |
| an MCP sidecar (shim/Dockerfile) change had no effect | `neuralis rebuild` builds `neuralisapp/mcp-sidecar:<version>` (the host's own version) only when its `io.neuralis.sidecar.source-hash` label differs from the directory — check the rebuild's `sidecar image` line (`up to date` vs `building`), `--no-sidecar` was not passed, and that running sidecars are idle-reaped (they keep the OLD shim until re-ensured) |

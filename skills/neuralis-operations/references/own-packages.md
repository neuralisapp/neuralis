# Your own native package

## Registration is a trust act

**Both lanes are a trust act, not a convenience.** Presence in the install folder's `package.json` dependencies (or, for `neuralis package`, in the runtime record) **is** the authorization boundary
(on the development checkout and a public clone that folder is the host package itself — so a
Docker-run public clone cannot carry operator packages: register them on an npm install folder, or
run the clone natively). A
dependency whose own manifest carries a `neuralis` block is discovered at boot and
loaded **in-process, with host-assigned native trust** — the same trust the
platform's own packages hold. There is no sandbox on this path; that is what
native means.

Only whoever controls the deployment configuration can grant it, and the change is a
one-line edit to a tracked file, so the diff is the audit surface. Vet a package here
exactly as you would vet any dependency you are about to run unsandboxed.

Two other install classes exist and are *not* this: a project-dropped package runs
WebAssembly-sandboxed, and a source package is markdown discovered in a synced source
with no install step at all. Reach for those first if the capability does not need
in-process trust.

## Install it while the host runs — `neuralis package`

**First choice, on every kind of install** — the desktop app, an image-only folder, an npm
install folder and a clone alike: install it into the RUNNING host.

```bash
neuralis package list                       # every package: slot (core, operator, runtime), status, how it changes
neuralis package install NAME@VERSION       # or a packed ./FILE.tgz — the host stages it and prints a summary
neuralis package approve REQUEST_ID         # or answer the prompt, or add --yes to install
neuralis package restart                    # it loads from the next start
neuralis package update NAME                # a newer version; `remove NAME` takes it out
```

The host stages the package without running any of its code and summarizes what it brings —
routes, tools, features and their default grants, config keys, credentials, and its build
source (an npm provenance attestation, or "no verified build source"). Asking needs
`platform.packages`; approving and restarting need `platform.packages.approve` as well, which
no role holds by default but the owner's — a person, an agent or the client alike. It is
recorded in the data folder (`<NEURALIS_HOME>/app/packages/`, which outlives a rebuild); the
restart is the desktop app's `up` or Docker's restart policy bringing the host back. The host
runs the npm of its own Node with `--ignore-scripts`, from the registry the "Package Registry"
setting names; it refuses while the private-scope record names a scope, and a name the image
ships stays the image's. **The operator's allow-list** narrows what may be installed at all:
`<NEURALIS_HOME>/app/packages/allow-list.json`, a JSON list of scopes and exact names
(`["@acme", "left-pad"]`), written on the server by its operator — no setting or screen writes
it. Missing or empty, every name may be asked for; a name it leaves out is refused before any
network step.

A finished package, end to end:

```bash
cd /home/me/work/my-package && npm pack                       # or publish it to a registry
neuralis package install ./acme-my-package-0.1.0.tgz          # or @acme/my-package@0.1.0
neuralis package restart                                      # after the approval
```

The loop below is for a package you are still DEVELOPING: the image lane, with a live bind.

## The loop — into this install's image with `neuralis pkg`

**Second, into this install's IMAGE** — an npm install folder or a clone (not the desktop app,
not an image-only folder): the package is built into the image by a rebuild.

```bash
neuralis pkg list                                  # builtin-class deps
neuralis pkg add NAME --path ABS_HOST_DIR   # a folder you are developing — the image build builds it (ABSOLUTE path: a relative one resolves from the shell's cwd)
neuralis pkg add NAME --tarball TARBALL       # a packed package, installed as packed
neuralis pkg add NAME --version VERSION       # a registry package at an EXACT version, public or private
neuralis pkg remove NAME                      # line + mount out; default role grants revoked at the next start
neuralis rebuild                                 # after either: this install's image installs or drops it
```

The development loop:

```bash
# 1. Register it — the trust act. Use the folder you are editing.
neuralis pkg add @acme/my-package --path /home/me/work/my-package

# 2. Install it. The image build builds the folder and installs it as node_modules/@acme/my-package.
neuralis rebuild

# 3. To edit it live: bind the folder over that installed copy, then restart once.
neuralis mount add /home/me/work/my-package --pkg @acme/my-package

# 4. From here on: edit, then build it in its folder and restart, in about a minute.
neuralis sync my-package

# 5. Check what the container actually has, any time.
neuralis sync status
```

Step 2 cannot be shortcut on first install: the image is where a package is installed,
and the bind in step 3 replaces an installed copy, it does not create one.
`pkg add` checks everything before it writes — the runtime's own admission check on the
folder (manifest and contributions), and its build contract: a `build` script (plus
`build:ui` running `neuralis-build ui` when it declares `app.module`), `files` covering
every runtime folder, the kernel as a peer, and no `link:`/`file:` spec that leaves the
folder. A refused add changes nothing and names every problem. An accepted add is also
recorded, so the first start that carries the package grants its default roles in every
existing project once; a revoke made by hand comes back only if you run `add` again.

**On an npm install folder the container runs the derived image, never a bind of the folder.**
Builtin discovery reads the IMAGE's `/neuralis/package.json`, so a registered package reaches the
container only through `neuralis rebuild`; a build that cannot install it names the package and
leaves the running stack as it was.

**On an npm install folder that image is the install's own derived image** (`FROM
neuralisapp/neuralis:<NEURALIS_IMAGE_TAG>`, generated into `operator-image/` beside the compose file
by `setup --compose-only`, which `rebuild` runs first). Its one layer installs the folder's
dependency lines but `neuralis` — the list `pkg add` validated, nothing from the environment — into
`/neuralis/_operator`, a root of its own: an `npm install` inside `/neuralis`, which has no
lockfile, would re-resolve the release image's whole tree. Each package is then linked at
`/neuralis/node_modules/<name>` and its line added to `/neuralis/package.json`, the manifest builtin
discovery reads; every `@neuralis/*` manifest of the release image stays byte-equal, peers are
never installed, and a second copy of an image `@neuralis/*` package is refused, so the image's one
kernel serves it. A folder builds there as in the image build (its own install, `build`, UI module)
and installs packed; a tarball installs as packed. The layer brings `python3`, `make` and `g++` for
native dependencies and removes them again; a failure names the package and leaves no half image.
A `mount add --pkg` bind never stands in for this: discovery would not see it.

Confirm registration with `neuralis pkg list`, which shows every builtin-class
dependency — that is, every dependency carrying a `neuralis` block, whatever its scope.

**From a private registry.** Put an `.npmrc` with your scope's lines only
(`@acme:registry=<url>` and its `_authToken` line — never a default `registry=`) somewhere
outside the repository and point `.env` `NEURALIS_BUILD_NPMRC` at it. Then
`neuralis pkg add @acme/x --version 1.2.3` (exact; refused while the file lacks the
scope), on the development checkout `pnpm install` so the tracked lock carries it (the command
prints the flag that lets your fresh release past the one-day age floor), and rebuild. An install
folder has no lock to update: its derived image resolves the package at that exact version under
the same one-day floor, lifted for the scopes the `.npmrc` routes privately — and refuses while ANY
scope in the private-scope record below has no route, since a registry package's own dependencies
are unknown before a registry is asked. The token never enters the image.

Once a scope is seen served privately — an `.npmrc` route, or a private host in the kept
build lock — it is recorded in `<NEURALIS_HOME>/build/private-scopes.json` (`pnpm
neuralis:setup`/`rebuild` write it) and never forgotten by itself: from then on `pkg add`
(a folder's or tarball's own dependencies, or `--version`) and the image build refuse that
scope without an `.npmrc` route, so its names are never asked of the public registry. To
forget a scope that is public now, delete its entry from that file (a broken file fails
closed). A scope this machine never saw served privately is indistinguishable from a public
one — its first resolve depends on your `.npmrc`.

**Removing it.** `neuralis pkg remove @acme/my-package` takes the line and the mount
out, records the features its manifest grants roles by default so the next start revokes
them (a hand grant stays, inert), and lists the data, config keys and credentials it leaves,
each with its delete command. Then rebuild.

**When it fails.** A `--path` or `--tarball` package is part of the image build, so a folder's
compile error — most often an `@neuralis/*` package it imports but does not declare as a peer
dependency, which the build then neither orders before it nor resolves — or either kind failing
the admission check stops the rebuild: the running instance keeps its previous image and
`neuralis rebuild` prints the error. Fix the package or `neuralis pkg remove` it, then rebuild.
A `--version` registry package the checks or the start refuse is left out alone — the platform runs, `neuralis rebuild` printed the reason, and
Admin health names it (`builtin-packages`; a refused UI module under `ui-modules` and in its
widget's place).

**A tool name is one key for the whole deployment, and adding a package can take one.**
There is no per-package prefix: if the package you register declares a tool name an
already-loaded package uses, one of them answers the bare name by default and the other
stays loaded — the native entry wins, and between two native entries (which
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
pnpm-lock.yaml`; `neuralis:rebuild` preflights this and names the fix).

## What makes a package syncable

Sync derives its set from the host's dependencies, not from any fixed directory, so your
own package is a first-class citizen of it. A dependency is syncable when:

- its manifest carries a `neuralis` block (it is builtin-class); **and**
- it resolves to a **directory** on this machine — a `--path` registration or a
  workspace link. A registry version has no source here to rebuild from, and a packed
  tarball cannot be rebuilt either; both are reported rather than silently skipped.

A folder builds in its OWN root, so it must build there on its own — its devDependencies
installed in it (a UI module needs React there). A folder bound with `--pkg` is then not
swapped: the container already reads it, and the restart loads the new build. An unbound
folder is packed and swapped like a platform package.

Address it by short name (`my-package`) or full registry name (`@acme/my-package`). If
two scopes ship the same short name, the short form is an error rather than a guess.

## Declare `files`, and declare it correctly

Your manifest needs a `files` whitelist, and sync refuses without one — packing would
otherwise ship your whole working directory, sources and tests included.

The trap worth knowing: **`files` must list first-level runtime directories.** A
whitelist that names only build output ships a package whose contributions are all
missing, and nothing errors — the package loads and simply contributes nothing. Start
from `dist` and add every top-level folder the package actually ships: `tools`,
`skills`, `workflows`, `rules`, `instructions`, `agents`, `docs`, `team`, `app`.

Sync packs with the same whitelist the image build's deploy applies, so what it swaps in
is exactly what a real install would contain — a whitelist mistake shows up in development
rather than after publishing.

## A workspace UI module

A package with `direct` widgets or cards ships them as ONE prebuilt browser module:
declare `app.module` in the manifest and build `dist/app/` with `neuralis-build ui`
(a `build:ui` script). The image build and sync run that step for a registered FOLDER too;
a tarball or registry package ships it prebuilt, so its owner **rebuilds it after every
platform upgrade**: the host refuses a module built for another host API version or React
major — including one built before the host recorded a React major — or whose entry exports
no `install<Name>HostComponents`, and its widgets show *"This widget cannot be rendered by
this host."* with the reason beside it. `neuralis rebuild` names every refused module.

## The standing rule

A synced container is a **development** container. Sync writes a divergence marker into
the container recording which packages were swapped, and that marker lives on the
image's own anonymous volume — so a proper rebuild removes it by construction, and it
can never outlive the divergence it describes.

Before any judgement that matters — an acceptance test, a claim that something works, a
deployment decision — run `neuralis rebuild` and judge that.

# Developing your own first-party package

## Registration is a trust act

Presence in the host's `package.json` dependencies **is** the authorization boundary. A
dependency whose own manifest carries a `neuralis` block is discovered at boot and
loaded **in-process, with host-assigned first-party trust** — the same trust the
platform's own packages hold. There is no sandbox on this path; that is what
first-party means.

Only whoever controls the deployment configuration can grant it, and the change is a
one-line edit to a tracked file, so the diff is the audit surface. Vet a package here
exactly as you would vet any dependency you are about to run unsandboxed.

Two other install classes exist and are *not* this: a project-dropped package runs
WebAssembly-sandboxed, and a source package is markdown discovered in a synced source
with no install step at all. Reach for those first if the capability does not need
in-process trust.

## The loop

```bash
# 1. Register it — the trust act. Use the folder you are editing.
pnpm neuralis:pkg add @acme/my-package --path /home/me/work/my-package

# 2. Install it. The image build builds the folder and installs it as node_modules/@acme/my-package.
pnpm neuralis:rebuild

# 3. To edit it live: bind the folder over that installed copy, then restart once.
pnpm neuralis:mount add /home/me/work/my-package --pkg @acme/my-package

# 4. From here on: edit, then build it in its folder and restart, in about a minute.
pnpm neuralis:sync my-package

# 5. Check what the container actually has, any time.
pnpm neuralis:sync status
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

Confirm registration with `pnpm neuralis:pkg list`, which shows every builtin-class
dependency — that is, every dependency carrying a `neuralis` block, whatever its scope.

**From a private registry.** Put an `.npmrc` with your scope's lines only
(`@acme:registry=<url>` and its `_authToken` line — never a default `registry=`) somewhere
outside the repository and point `.env` `NEURALIS_BUILD_NPMRC` at it. Then
`pnpm neuralis:pkg add @acme/x --version 1.2.3` (exact; refused while the file lacks the
scope), `pnpm install` on the host so the tracked lock carries it (the command prints the
flag that lets your fresh release past the one-day age floor), and rebuild. The token never
enters the image.

Once a scope is seen served privately — an `.npmrc` route, or a private host in the kept
build lock — it is recorded in `<NEURALIS_HOME>/build/private-scopes.json` (`pnpm
neuralis:setup`/`rebuild` write it) and never forgotten by itself: from then on `pkg add`
(a folder's or tarball's own dependencies, or `--version`) and the image build refuse that
scope without an `.npmrc` route, so its names are never asked of the public registry. To
forget a scope that is public now, delete its entry from that file (a broken file fails
closed). A scope this machine never saw served privately is indistinguishable from a public
one — its first resolve depends on your `.npmrc`.

**Removing it.** `pnpm neuralis:pkg remove @acme/my-package` takes the line and the mount
out, records the features its manifest grants roles by default so the next start revokes
them (a hand grant stays, inert), and lists the data, config keys and credentials it leaves,
each with its delete command. Then rebuild.

**When it fails.** A package the build or the start refuses is left out alone — the platform
runs, `pnpm neuralis:rebuild` printed the reason, and Admin health names it
(`builtin-packages`; a refused UI module under `ui-modules` and in its widget's place).

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
this host."* with the reason beside it. `pnpm neuralis:rebuild` names every refused module.

## The standing rule

A synced container is a **development** container. Sync writes a divergence marker into
the container recording which packages were swapped, and that marker lives on the
image's own anonymous volume — so a proper rebuild removes it by construction, and it
can never outlive the divergence it describes.

Before any judgement that matters — an acceptance test, a claim that something works, a
deployment decision — run `pnpm neuralis:rebuild` and judge that.

# What the image build does

Useful for answering "why does *that* need a rebuild?" and "why did the build fail
there?". The build steps under `scripts/build/` are invoked by the Dockerfile and by
`pnpm build`; none of them is run by hand.

## Container image layout

The runner image uses a **flat WORKDIR** with image-built runtime artefacts
isolated inside a `_runtime/` subdirectory so a whole-folder `--neuralis`
overlay can bind the host `neuralis/` folder onto `/neuralis` without
hiding the Next.js entry point.

```text
/neuralis/                              ← WORKDIR (runner) — same shape as host neuralis/
  _runtime/                             ← anon-vol-protected (image-built ONLY)
    server.js                           ← Next.js standalone entry
    .next/                              ← built static + server output
    public/                             ← static assets
  node_modules/                         ← anon-vol-protected (separate from _runtime/)
    @neuralis/agent-core/               ← real dir (`pnpm deploy`, files[] applied)
    @neuralis/brain-core/               ← real dir
    @acme/your-package/                 ← real dir — any scope, any source
    …                                   ← every production dependency, real dirs
  src/                                  ← from standalone tracer (host-overlay-compatible)
  scripts/                              ← mount.mts, reset-vector.mts (likewise)
  public/                              ← also from standalone tracer
  Dockerfile, README.md, package.json   ← root config (host-overlay-compatible)
  next.config.ts, postcss.config.mjs    ← (likewise)
  tsconfig.json                         ← (likewise)
```

`docker-compose.yml` is **not** in the image (`.dockerignore`): it is
setup-generated machine-specific host topology and never ships in a build
artifact. In-container tooling detects Docker via `/.dockerenv`
(`mount.mts isDockerMode()`), not via a baked compose file.

`CMD ["node", "_runtime/server.js"]`. Next.js standalone's server.js does
`process.chdir(__dirname)` and `dir = __dirname`, so all Next-relative
paths (`.next/`, `public/`, `required-server-files.json`) resolve under
`_runtime/`. Node module resolution walks UP from server.js:
`_runtime/node_modules/` (absent) → `/neuralis/node_modules/` ✓ — finds every
deployed package. `_runtime/build/` holds the image build's report: `validate.json`
(the builtins the build refused — the boot reads it), `ui-compat.json` and, when
local packages were built, the lock they resolved to (both read by
`pnpm neuralis:rebuild` only).

`node_modules/` deliberately lives at `/neuralis/node_modules/` (NOT inside
`_runtime/`) so skills/tooling that reference
`node_modules/@neuralis/<slug>/skills/...` paths don't need to grow an
extra path segment. The `_runtime/` and `node_modules/` directories are
protected by **separate** anonymous volumes when the `--neuralis` overlay
is active — both survive the host-folder bind mount.

There is no `packages/` directory at runtime: every builtin — the platform's
own, a local folder or tarball, a registry package of any scope — is a real
directory under `node_modules/<name>/`, the same shape a registry install
produces.


## The stages

```
local-sources ──► builder ─────────────────────────────────────► app-builder ──► runner
place each        install (lock) → build every package in       next build on    copy the
registered        dependency order → pnpm deploy --prod →       the deploy tree  deploy tree
folder/tarball    judge the tree (bindings, overrides, UI,                       + the build
                  admission, conflicts)                                          report
```

**One workspace for every package.** The platform's own packages, a folder registered
with `--path`, a tarball registered with `--tarball` and a registry version all go through
the same pnpm install and the same `pnpm deploy`, and land in the runner as real
directories at `node_modules/<name>` — any scope or none. `pnpm neuralis:rebuild`
regenerates the compose first, which hands each registered folder or tarball to the build
as a named context (at most eight). A folder becomes a workspace member and is built like
a platform package (its `build`, then its UI module when it declares one); a tarball is
installed as packed. A folder that cannot build on its own — no `build` script, a
`link:`/`file:` spec that leaves it — fails the build with that package named.

**The lock is the authority.** With no local package the install is frozen on the tracked
`pnpm-lock.yaml`. A local package's own dependencies resolve inside the build — from the
lock a previous green build kept (when it was made for the same tracked lock, the same
local packages and the same tarball bytes), else fresh — and every tracked entry must
survive unchanged, or the build fails naming it. A dependency the tracked lock does not
carry fails too: add it on the host with `pnpm install` and commit the lock.

**A private registry** comes from the `.env` `NEURALIS_BUILD_NPMRC` file (scope lines only),
mounted as a build secret for the two network steps — never a layer. A scope the build needs
that is known private (the host's private-scope record, a lock or a manifest) and that the
file does not route stops the build before anything is fetched. The privately routed
scopes skip the one-day minimum release age; every public package keeps it.

**Judged before the image exists.** After the deploy the build checks that the native
bindings load, prints the resolved version of every override pin, judges every UI module
against this host, and judges every package with the runtime's own admission check and, as
a set, for two packages claiming one service, OAuth prefix or configuration key. A package
this build built (platform or folder) that fails fails the build; a registry package that
fails is refused, named, recorded in `_runtime/build/validate.json`, and the platform starts
without it. `pnpm neuralis:rebuild` prints every refusal.

## The two-gate rule

A module is kept out of the server bundle only when its resolved real path is a real
path **inside `node_modules`** *and* ends in a JavaScript extension. Both gates. The
host imports only a package's build output, which resolves inside `node_modules` and
ends in `.js` → external: one module instance, shared by the host's static imports and
the package loader's dynamic import, so module-level state cannot split. A package's UI
is never compiled by the host build at all — it is a prebuilt browser module
(`dist/app/`, `neuralis-build ui`) the host attaches at runtime.

The Docker-only Next build runs on the deploy tree itself, purely because a workspace
checkout is the one place the package roots are not already real directories.

## The guards

Three checks fail the build rather than letting a broken image ship:

- **Zero bundled copies.** Any package compiled into the server chunks fails. This is
  the invariant that makes a live package swap sound at all. It applies where zero is
  achievable — the guard reads the tree to decide: in a development workspace the
  packages are symlinks, bundling is structural, and no edit could satisfy the rule, so
  there the counts are reported and the build passes. Against installed directories the
  requirement is enforced.
- **At least one external alias emitted.** A bundler layout change must not silently
  turn the externalization step into a no-op.
- **Native bindings load.** Existence is not binding: each declared native artifact is
  actually loaded, because a traced copy can be present and unusable.

## Rebuild triggers, restated

Package source, host source, dependencies and a registered or removed package all need a
rebuild — the runtime serves a compiled build and reads installed packages. A package UI's classes ride its own source:
the host compiles one package stylesheet from the installed packages' `app/` trees when
it loads them. Configuration and credentials under the data directory are read live and
need nothing.

The virtual desktop image is built separately and a host rebuild does **not** touch it;
its build command lives in its Dockerfile header, and a change to it is invisible until
that image is rebuilt and its sessions respawned. The MCP sidecar image is also a separate
image, but `pnpm neuralis:rebuild` builds it after a green app build whenever it is missing
or its source-hash label differs from its directory; running sidecars keep the old shim
until they are reaped and re-ensured.


## External aliases and native addons

Every `serverExternalPackages` entry gets an alias directory emitted by Turbopack
under `_runtime/.next/node_modules/<name>-<hash>`, and that alias is a *relative
symlink into the path the resolver saw at build time* — i.e. into the builder's
pnpm store (`node_modules/.pnpm/<name>@<version>/node_modules/<name>`). The
runner has no pnpm store; what it has beside the deploy tree is the fragment the
**Next.js file tracer** copied in, which holds only the files static analysis
could reach.

Note that "native addon" is only the most common reason an entry is on
`serverExternalPackages`; a package can also be unbundleable for pure packaging
reasons. `@xterm/headless` (the terminal's server-side emulator mirror) declares
`"module": "lib/xterm.mjs"`, a file its published tarball does not contain, and
ships no `exports` map — so a bundler that honours `module` resolves to nothing,
while Node's own resolver falls back to the `main` that does exist. It and
`@xterm/addon-serialize` are therefore listed for the same practical outcome as
a native dep: they must be required at runtime, never inlined.

For a pure-JS external that fragment happens to be enough. For a package with a
native addon it is not: `node-pty` loads `build/Release/pty.node` through a
computed path no tracer can see, so the traced copy ships `lib/` alone — and the
alias resolves *to that copy*, so every PTY spawn fails while the compiled copy
sits unused at `node_modules/node-pty`. The same shape also yields duplicate
module instances (`ws` resolved twice at two patch versions — one class per
module graph, `instanceof` false across the boundary).

# syntax=docker/dockerfile:1
# The syntax directive pins the BuildKit Dockerfile frontend so the
# `RUN --mount=type=cache` steps below are supported on every Docker/BuildKit
# version (a deploy/CI host may run an older built-in frontend).
# ── Base-image pins ─────────────────────────────────────────
# Every FROM is digest-pinned: a floating tag makes an image rebuild
# irreproducible and silently adopts whatever the registry moved the tag to.
# The human-readable tag stays in the reference so the intent is visible.
# Refresh (deliberately, as its own commit, with the new digests recorded):
#   docker buildx imagetools inspect node:26-alpine3.24 | grep Digest
#   docker buildx imagetools inspect alpine:3.24        | grep Digest
# Digests taken 2026-09-24 (manifest lists — multi-arch safe). The base and the
# helper stages share one alpine release.
FROM node:26-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS base
# pnpm at EXACTLY the version the repo pins (root package.json `packageManager`;
# packages/package-system/test/packagingDrift.test.ts holds the two equal).
# Node 25+ ships no corepack, and the runner inherits this binary, so a pnpm call
# in the container runs this version instead of downloading one.
# `--allow-scripts=pnpm`: npm 11 skips a dependency's install scripts unless they
# are allowed, and pnpm's own install script is what links its native binary.
ARG PNPM_VERSION=12.6.0
RUN npm install -g --allow-scripts=pnpm pnpm@${PNPM_VERSION} && pnpm --version

# ── extism-js fetch stage ───────────────────────────────────
# Pinned, checksum-verified download from the official extism/js-pdk release.
# Runs as a dedicated stage so the binary is fetched once and COPY'd into the
# runner. Any failure here (network, checksum mismatch, arch support) fails the
# image build loudly — no silent fallback.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS extism-js-dl
ARG EXTISM_JS_VERSION=v1.7.0
ARG TARGETARCH
RUN apk add --no-cache curl ca-certificates && \
    case "${TARGETARCH:-amd64}" in \
      amd64) ARCH=x86_64 ;; \
      arm64) ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    URL="https://github.com/extism/js-pdk/releases/download/${EXTISM_JS_VERSION}/extism-js-${ARCH}-linux-${EXTISM_JS_VERSION}.gz" && \
    curl -fsSL -o /tmp/extism-js.gz "${URL}" && \
    EXPECTED_SHA=$(curl -fsSL "${URL}.sha256" | awk '{print $1}') && \
    echo "${EXPECTED_SHA}  /tmp/extism-js.gz" | sha256sum -c - && \
    gunzip /tmp/extism-js.gz && \
    chmod +x /tmp/extism-js

# ── binaryen fetch stage ────────────────────────────────────
# extism-js shells out to `wasm-merge` (and `wasm-opt`) from binaryen. The
# js-pdk install.sh still names version_125; this pin is newer and is proved by
# building a WASM package with the pinned extism-js before it ships. The archive
# checksums are PINNED here (recorded from the release's .sha256 assets), so a
# replaced release asset fails the build. Ships only the two binaries we
# actually need into the runner.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS binaryen-dl
ARG BINARYEN_VERSION=version_133
ARG BINARYEN_SHA256_X86_64=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
ARG BINARYEN_SHA256_AARCH64=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8
ARG TARGETARCH
RUN apk add --no-cache curl ca-certificates tar && \
    case "${TARGETARCH:-amd64}" in \
      amd64) ARCH=x86_64; EXPECTED_SHA="${BINARYEN_SHA256_X86_64}" ;; \
      arm64) ARCH=aarch64; EXPECTED_SHA="${BINARYEN_SHA256_AARCH64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-${ARCH}-linux.tar.gz" && \
    curl -fsSL -o /tmp/binaryen.tar.gz "${URL}" && \
    echo "${EXPECTED_SHA}  /tmp/binaryen.tar.gz" | sha256sum -c - && \
    mkdir -p /tmp/binaryen && \
    tar -xzf /tmp/binaryen.tar.gz -C /tmp/binaryen --strip-components=1 && \
    test -x /tmp/binaryen/bin/wasm-merge && \
    test -x /tmp/binaryen/bin/wasm-opt

# ── landlock sandboxer build stage (warded-bailey) ──────────
# The OS-enforcement helper: a tiny, dependency-free, musl-static binary that
# turns on a Landlock LSM filesystem sandbox for LOWER-TRUST agent shells, then
# execve()s the command. Owner/admin (exec.unconfined) run WITHOUT it (bare
# spawn) — the helper is only spawned for confined agents. Compiled from the
# VENDORED source (no external download → lowest supply-chain risk).
#
# The `--selftest` smoke proves BOTH enforcement layers here at build time, on
# the SHIPPED musl-static artifact rather than on a glibc dev build:
#   1. the Landlock syscall sequence + deny-outside/allow-inside enforcement;
#   2. (since 2026-08-18) the seccomp AF_UNIX filter, installed in a FORKED
#      CHILD — native AF_UNIX denied, an ALTERNATE-ABI (x32) socket() denied,
#      AF_INET and socketpair() still allowed. This half is not cosmetic: the
#      filter was previously reachable only from a `--deny-unix-sockets` spawn,
#      so this stage, the container boot probe and the broker readiness probe
#      were ALL blind to a broken filter and all three passed green while an
#      x32-numbered socket() walked straight around it.
# It TOLERATES exit 91 (Landlock ABI < 3 on the BUILD kernel) because Landlock
# availability is a RUNTIME (deploy host-kernel) property, not a build property
# — coupling image-buildability to the build host's kernel would be wrong for a
# distributable image. Nothing else is tolerated: a compile error, a Landlock
# enforcement bug (exit 93) and a broken/bypassable seccomp filter (exit 95)
# each fail the build loudly. The RUNTIME boot-live-test remains the enforcement
# gate for the Landlock half on the deploy host.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS landlock-dl
RUN apk add --no-cache gcc musl-dev linux-headers
COPY neuralis/docker/landlock-sandboxer.c /tmp/landlock-sandboxer.c
RUN gcc -static -O2 -Wall -Wextra -o /tmp/nrs-sandboxer /tmp/landlock-sandboxer.c && \
    ( /tmp/nrs-sandboxer --selftest || [ $? -eq 91 ] )

# ── Workspace manifests ─────────────────────────────────────
# Every packages/<dir>/package.json at its own path, and nothing else — the
# install layer below needs exactly these. Derived from the tree instead of one
# COPY per package, so a package that lands or leaves needs no edit here. The
# COPY of the whole tree re-runs on any package edit, but its OUTPUT is content-
# addressed: the builder's `COPY --from=manifests` (and the install after it)
# stays cached until a manifest itself changes.
FROM base AS manifests
WORKDIR /src
COPY packages packages
RUN mkdir -p /out/packages && cd packages && for manifest in */package.json; do \
      mkdir -p "/out/packages/${manifest%/package.json}" && cp "$manifest" "/out/packages/$manifest"; \
    done

# ── Local package sources ───────────────────────────────────
# A package registered from a folder or a tarball OUTSIDE this repository
# (`pnpm neuralis:pkg add --path|--tarball` → a `file:` dependency of
# neuralis/package.json) reaches the build only as a named context: the
# generated compose (`buildComposeContent`, re-run by `pnpm neuralis:rebuild`
# before every build) OVERRIDES one of these empty stages per registered source,
# in name order. An unused slot stays empty. The slot count is a bound, not a
# list: neuralis/scripts/build/build-workspace.mjs (`LOCAL_SOURCE_SLOTS`)
# refuses more sources than there are stages.
FROM scratch AS localpkg0
FROM scratch AS localpkg1
FROM scratch AS localpkg2
FROM scratch AS localpkg3
FROM scratch AS localpkg4
FROM scratch AS localpkg5
FROM scratch AS localpkg6
FROM scratch AS localpkg7
# The lock a previous green build resolved the local packages' own registry
# dependencies to — exported by `pnpm neuralis:rebuild`, used only when it was
# resolved over the SAME tracked pnpm-lock.yaml — and the private-scope record
# beside it (every scope this machine has seen served privately). Empty when
# neither is there.
FROM scratch AS buildlock

# Place every source in the build workspace (`local/<name>/` as a workspace
# member, a tarball as `local-tgz/<name>.tgz`) and write the build-side copies
# of the host manifest and pnpm-workspace.yaml that point at them. The tracked
# files are never edited. A local package whose own manifest cannot be built
# here (a `link:`/`file:` spec that leaves it, a missing `build` script) fails
# THIS step with the package and the spec named.
FROM base AS local-sources
WORKDIR /stage
COPY --from=manifests /out/ ./ws/
COPY pnpm-workspace.yaml ./ws/
COPY neuralis/package.json ./ws/neuralis/
COPY neuralis/scripts/build/build-workspace.mjs /tmp/build-workspace.mjs
COPY --from=localpkg0 / ./slots/0/
COPY --from=localpkg1 / ./slots/1/
COPY --from=localpkg2 / ./slots/2/
COPY --from=localpkg3 / ./slots/3/
COPY --from=localpkg4 / ./slots/4/
COPY --from=localpkg5 / ./slots/5/
COPY --from=localpkg6 / ./slots/6/
COPY --from=localpkg7 / ./slots/7/
RUN node /tmp/build-workspace.mjs stage /stage/ws /stage/slots /out

# ── Build (ONE pnpm workspace: install → build → deploy) ────
# The tracked pnpm-lock.yaml is the install's authority, and `pnpm deploy`
# produces the runner's node_modules from the SAME graph: every package —
# workspace, local folder, tarball, registry, any scope — lands as a REAL
# directory at node_modules/<name>, its `files` whitelist applied.
#
# `--config.node-linker=hoisted` rides ONLY these command lines: it is what
# makes the deploy copy real directories instead of `.pnpm/` symlinks, and it
# never enters the lock (the dev workspace keeps its isolated linker and the
# same lock). Never `pnpm deploy --legacy` — with hoisted it exits 0 with an
# EMPTY node_modules. Never `--ignore-scripts`: node-pty's native build is an
# install script (`allowBuilds` in pnpm-workspace.yaml names it).
#
# A private registry's token never enters a layer: the operator's `.npmrc`
# (scope lines only, path from `.env` NEURALIS_BUILD_NPMRC) is a BuildKit secret
# mounted at /root/.npmrc for each install/deploy step, and the repo's `.npmrc`
# is dockerignored.
FROM base AS builder
# node-pty has no prebuilt binary for this node ABI, so it compiles from source
# via node-gyp at install time. python3 + a `python` alias cover gyp's
# interpreter lookup (gyp scripts use a `#!/usr/bin/env python` shebang).
RUN apk add --no-cache python3 make g++ && ln -sf python3 /usr/local/bin/python
WORKDIR /src

COPY package.json pnpm-lock.yaml* ./
COPY --from=local-sources /out/pnpm-workspace.yaml ./
COPY --from=manifests /out/ ./
COPY --from=local-sources /out/neuralis/ ./neuralis/
COPY --from=local-sources /out/local-manifests/ ./
COPY --from=local-sources /out/local-tgz/ ./local-tgz/
COPY --from=buildlock / /tmp/buildlock/
COPY neuralis/scripts/build/build-workspace.mjs /tmp/build-workspace.mjs

# Restore the exec bit on the gyp_main.py of the node-gyp that pnpm bundles (the
# one that compiles node-pty) before install.
#
# Root cause: under BuildKit, layer files can be a fraction of a second
# future-dated, so `make` decides node-pty's Makefile is stale and regenerates
# it; that rule execs gyp_main.py *directly* (via its `#!/usr/bin/env python`
# shebang), so the file must be executable. An extraction path that drops the
# exec bit (pnpm's content-addressable store did, when pnpm itself came from
# there) makes `make` abort with "Permission denied" (Error 126).
#
# The npm-installed pnpm (base stage) carries its node-gyp under
# /usr/local/lib/node_modules/pnpm/dist. We re-chmod every gyp_main.py there and
# FAIL LOUD if none is found — a future pnpm layout change then surfaces as an
# explicit build error here, not a cryptic 126 mid-compile.
#
# The `|| true` on the find is load-bearing: BusyBox find exits non-zero when a
# search root is missing, which — inside `found="$(...)"` — would break the `&&`
# chain; the `[ -n "$found" ]` guard below still fails loud if NO gyp_main.py
# exists.
#
# The lock: with no local package the tracked lock is FROZEN. A local package is
# not in the tracked lock (it cannot be — its path is this machine's), so its
# own dependencies resolve here: from the exported build lock when it fits,
# else fresh, and either way every tracked lock line must survive unchanged or
# the build fails. The exported lock is refused when it was resolved for another
# set of local packages (one removed or added since) or a tarball it pins changed
# since (same staged path, new bytes).
#
# Before pnpm touches the network, a scope a lock, a manifest or the private-scope
# record shows served by a private registry must have its route in the .npmrc
# secret, or nothing is resolved: pnpm would ask the PUBLIC registry for that
# scope's names.
#
# `minimumReleaseAge` (one day, pnpm-workspace.yaml) is lifted for the scopes the
# .npmrc secret routes to a PRIVATE registry only — the operator's own release
# installs at once, every public package keeps the floor. The flags are derived
# from the secret's scope lines on the command line (`set -f`: a `@scope/*`
# pattern is pnpm's, never a shell glob).
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    set -f && \
    node /tmp/build-workspace.mjs scope-routes /tmp/buildlock pnpm-lock.yaml /src /root/.npmrc && \
    rae="$(node /tmp/build-workspace.mjs release-age-excludes /root/.npmrc)" && \
    pnpm --version && \
    found="$(find /usr/local/lib/node_modules/pnpm/dist -name 'gyp_main.py' 2>/dev/null || true)" && \
    [ -n "$found" ] && printf '%s\n' "$found" | xargs chmod +x && \
    cp pnpm-lock.yaml /tmp/tracked-lock.yaml && \
    if [ -n "$(ls -A local 2>/dev/null)$(ls -A local-tgz 2>/dev/null)" ]; then \
      if node /tmp/build-workspace.mjs lock-base /tmp/buildlock /tmp/tracked-lock.yaml /src; then \
        cp /tmp/buildlock/pnpm-lock.yaml pnpm-lock.yaml; fi && \
      pnpm install --no-frozen-lockfile --config.node-linker=hoisted $rae && \
      node /tmp/build-workspace.mjs verify-lock /tmp/tracked-lock.yaml pnpm-lock.yaml /src; \
    else \
      pnpm install --frozen-lockfile --config.node-linker=hoisted $rae; \
    fi

COPY tsconfig.base.json ./

# ── Build every workspace package, in dependency order ──
# The platform's packages and every local folder package build the same way:
# its `build` script, then — when it declares `neuralis.app.module` — its
# workspace UI module (dist/app/, attached by the host at runtime) through the
# kernel CLI called by its node path (the `neuralis-build` bin link is created
# at install time, before the kernel's dist/ exists). `--sort` walks the
# dependency graph, so the kernel builds first and a package builds after
# everything it reads; one at a time keeps peak memory where it was. No
# package is named here: the set is the workspace.
COPY packages packages
COPY --from=local-sources /out/local/ ./local/
RUN pnpm -r --sort --workspace-concurrency=1 --filter './packages/*' --filter './local/*' \
      exec node /tmp/build-workspace.mjs build-package /src/packages/package-system

# The runner's node_modules: the host's production dependency closure, every
# package a real directory (node-pty's binding comes along from the install's
# side-effects cache). Then the checks that read it: the two native bindings
# load, every override pin's resolved version is printed, every installed UI
# module is judged against THIS host's API and React and for its install export
# (refusals are named here and again by `pnpm neuralis:rebuild`; the runtime
# refuses the same set — the export at attach, in the widget's place), every
# installed package is judged by the runtime provider's admission predicate and,
# as a set, for two packages claiming one contract or config key (a package
# built here — workspace or local — that fails either fails the build; a
# registry package is named and refused, and the boot leaves it out alone by
# the record `_runtime/build/validate.json`), and — when local packages were
# built — the lock they resolved to is kept for export.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    set -f && \
    rae="$(node /tmp/build-workspace.mjs release-age-excludes /root/.npmrc)" && \
    pnpm --config.node-linker=hoisted --filter ./neuralis --prod deploy /deploy $rae && \
    cd /deploy && \
    node -e "require('node-pty'); console.log('[deploy] node-pty native binding OK')" && \
    node -e "require('@tailwindcss/oxide'); console.log('[deploy] tailwind oxide native binding OK')" && \
    node /tmp/build-workspace.mjs overrides /src/pnpm-workspace.yaml /deploy && \
    node /tmp/build-workspace.mjs ui-compat /deploy /src/packages/package-system /tmp/build-report/ui-compat.json && \
    node /tmp/build-workspace.mjs validate /deploy /src/packages/package-system /src/neuralis/package.json /src/pnpm-lock.yaml /tmp/build-report/validate.json && \
    if [ -n "$(ls -A /src/local 2>/dev/null)$(ls -A /src/local-tgz 2>/dev/null)" ]; then \
      node /tmp/build-workspace.mjs export-lock /src/pnpm-lock.yaml /tmp/tracked-lock.yaml /tmp/build-report; fi

# ── App build (Next.js) ─────────────────────────────────────
# Continues the builder — same workspace, every package built — on the deploy
# tree: Next externalizes a module only when its resolved realpath is a real
# path inside node_modules AND ends in a JS extension, and a workspace install
# links packages as symlinks, which fails gate 1 for every one of them (all
# were once compiled into the server chunks: two module graphs at runtime). So
# the host's node_modules IS the deploy's production tree — the graph the
# runner ships — and the build toolchain (typescript, the postcss plugin)
# resolves from the workspace root one level up. The host imports no package
# `app/` source: every package UI is a prebuilt runtime module.
FROM builder AS app-builder
WORKDIR /src
RUN rm -rf neuralis/node_modules && cp -a /deploy/node_modules neuralis/node_modules
COPY neuralis neuralis
# The build-side host manifest again (the whole-folder COPY above re-imported
# the host's own, whose local `file:` paths exist only on the host). It is what
# the standalone output embeds as the runner's package.json.
COPY --from=local-sources /out/neuralis/package.json neuralis/package.json
# NEXT_PUBLIC_* vars are inlined into the client bundle at `next build` —
# runtime compose env can never change them. The image is Docker by definition.
ENV NEXT_PUBLIC_NEURALIS_DOCKER=true
RUN --mount=type=cache,target=/src/neuralis/.next/cache,id=neuralis-next \
    mkdir -p neuralis/public && cd neuralis && \
    NEXTAUTH_SECRET=neuralis-ci-build-only-not-a-runtime-secret pnpm run build

# ── Runner ──────────────────────────────────────────────────
# Layout (wave6.6 — whole-folder --neuralis overlay):
#   /neuralis/_runtime/server.js          ← image-built (anon vol protected)
#   /neuralis/_runtime/.next/             ← image-built (anon vol protected)
#   /neuralis/_runtime/public/            ← image-built (anon vol protected)
#   /neuralis/_runtime/package.json       ← image-built (needed by bundled chunks)
#   /neuralis/node_modules/<name>         ← image-built (separate anon vol)
#   /neuralis/{src/, scripts/, docs/,     ← from standalone tracer (overlay-shadowed
#     Dockerfile, README.md, package.json,  when --neuralis active, baked-in fallback
#     next.config.ts, postcss.config.mjs,   when inactive)
#     tsconfig.json, vitest.config.mts, .env}
#   docker-compose.yml is NOT baked (.dockerignore) — it is setup-generated,
#   machine-specific host topology (see docs/architect/setup-and-update.md).
#
# Why _runtime/ subdir for server.js: a whole-folder `host:/neuralis`
# bind mount would hide a single file like /neuralis/server.js because
# Docker anonymous volumes cannot protect files (directories only).
# Moving server.js + .next + public into `_runtime/` lets a single anon
# vol protect them. Everything else from the standalone tracer stays at
# /neuralis/ root so the host overlay drops in cleanly with the SAME shape
# as the host neuralis/ folder.
#
# Why node_modules/ stays at /neuralis/node_modules/ (NOT inside _runtime/):
# skills, tooling, and docs hardcode `node_modules/@neuralis/<slug>/files/skills/...`
# paths — pulling them under `_runtime/` would add an extra path segment
# everywhere. The node_modules dir gets its OWN anon vol.
#
# Path resolution still works because Next.js standalone's server.js does
# `process.chdir(__dirname)` and Node walks UP from server.js's location
# for require resolution: `_runtime/node_modules/` (empty) → `/neuralis/node_modules/` ✓.
#
# node_modules/<name>/ are real directories (the builder's `pnpm deploy`, no
# `.pnpm/` symlink indirection) — short, stable require.resolve() paths and
# short ${SKILL_DIR} substitutions, for every scope alike.
FROM base AS runner
WORKDIR /neuralis

# ── Version identity ────────────────────────────────────────
# A running deployment could not say what it was. The labels are for whoever
# inspects the image; NEURALIS_VERSION/REVISION are the same values reaching
# the PROCESS, because a label is invisible from inside the container and the
# admin environment table reads process env. Both surfaces are authenticated —
# the anonymous health endpoint deliberately carries no version, since an exact
# version on a public endpoint is a CVE-targeting aid for self-hosted installs.
ARG NEURALIS_VERSION=0.0.0-dev
ARG NEURALIS_REVISION=unknown
LABEL org.opencontainers.image.title="neuralisapp/neuralis" \
      org.opencontainers.image.description="Neuralis — self-hosted multi-LLM agent platform." \
      org.opencontainers.image.vendor="Eszes LLC" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.source="https://github.com/neuralisapp/neuralis" \
      org.opencontainers.image.version="${NEURALIS_VERSION}" \
      org.opencontainers.image.revision="${NEURALIS_REVISION}"
ENV NEURALIS_VERSION=${NEURALIS_VERSION}
ENV NEURALIS_REVISION=${NEURALIS_REVISION}

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEURALIS_HOME=/.neuralis
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
# :3100 keep-alive — avoid the Node-default 5s RST race on reused HTTP/1.1
# keep-alive sockets (browser reopens a socket the server just closed →
# net::ERR_CONNECTION_RESET on a random fetch). `_runtime/server.js` reads this
# env and passes it to startServer({ keepAliveTimeout }). Stays under the 60s
# headersTimeout that Next standalone leaves at the Node default. The non-Docker
# channels (next start) take the same value via the --keepAliveTimeout flag in
# package.json. See docs/architect/realtime-transport.md.
ENV KEEP_ALIVE_TIMEOUT=55000

ARG UV_VERSION=0.12.21

# Skill-runtime baseline (W4D + W4E skill protocol — Anthropic-compat).
# Imported skills activate through `execute action="skill"`, render a SKILL.md
# body with substitutions like `${SKILL_DIR}` / `${NEURALIS_API}`, then often
# call companion `scripts/*.sh` via bash. Those scripts routinely assume a
# standard Unix toolbox (bash/coreutils/git/curl/jq/yq/findutils/grep), while
# imported Python skills commonly rely on `python3` + `pip` + `venv` + `uv` to
# execute single-file scripts with inline dependency metadata.
#
# `docker-cli` ships so the `--with-docker` overlay mount can drive the
# host Docker daemon from inside the container. The /var/run/docker.sock
# bind-mount itself is opt-in via `pnpm neuralis:mount add ... --with-docker`
# (or the default machine-core mount in docker-compose.yml).
RUN apk add --no-cache \
      bash coreutils gcompat ca-certificates file \
      ripgrep git grep gawk sed findutils \
      curl wget jq yq openssl \
      tar gzip unzip zip xz bzip2 \
      python3 py3-pip py3-virtualenv \
      ffmpeg poppler-utils \
      make github-cli docker-cli docker-cli-compose && \
    python3 -m pip install --break-system-packages --no-cache-dir "uv==${UV_VERSION}" && \
    rg --version >/dev/null && git --version >/dev/null && grep --version >/dev/null && \
    curl --version >/dev/null && wget --version >/dev/null && \
    jq --version >/dev/null && yq --version >/dev/null && \
    python3 --version >/dev/null && python3 -m pip --version >/dev/null && \
    uv --version >/dev/null && \
    openssl version >/dev/null && file --version >/dev/null && \
    ffmpeg -version >/dev/null && ffprobe -version >/dev/null && \
    which pdftotext >/dev/null && which pdftoppm >/dev/null && \
    gh --version >/dev/null && docker --version >/dev/null && docker compose version >/dev/null

# ffmpeg (+ffprobe): the media delivery boundary's frame-sampling leg —
# video → ≤12 JPEG frames for models without native video ingest
# (agent-core stream/media/frameSample.ts; probe-and-degrade, boot never
# depends on it). poppler-utils: pdftotext/pdftoppm for brain-core's PDF
# read path — it was silently absent from the image (the LocalDiskConnector
# degrade path masked it in prod; owner-approved rider, media Inc 3'c).

# extism-js + binaryen (wasm-merge, wasm-opt) — the WASM build toolchain for
# user packages. Copied from dedicated fetch stages (pinned, checksum-verified).
COPY --from=extism-js-dl /tmp/extism-js /usr/local/bin/extism-js
COPY --from=binaryen-dl /tmp/binaryen/bin/wasm-merge /usr/local/bin/wasm-merge
COPY --from=binaryen-dl /tmp/binaryen/bin/wasm-opt /usr/local/bin/wasm-opt
RUN extism-js --version && wasm-merge --version && wasm-opt --version

# warded-bailey Landlock sandboxer — the OS-enforcement wrapper spawned for
# lower-trust agent shells (agent-core shellRunner). Resolved at runtime by
# NEURALIS_LANDLOCK_SANDBOXER (default /usr/local/bin/nrs-sandboxer). The smoke
# tolerates exit 91 (ABI < 3) for the same reason as the build stage, and — like
# the build stage — now also fails the image on exit 95 (the seccomp AF_UNIX /
# alternate-ABI filter could not be installed or did not enforce).
COPY --from=landlock-dl /tmp/nrs-sandboxer /usr/local/bin/nrs-sandboxer
RUN ( nrs-sandboxer --selftest || [ $? -eq 91 ] )

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 1. Next.js standalone output → /neuralis/ ROOT (flat layout). The
#    standalone tree is `.next/standalone/neuralis/{server.js, package.json,
#    .next/, src/, scripts/, Dockerfile, docs/, …}` — copying the CONTENT
#    of the inner `neuralis/` subdir directly onto the WORKDIR gives us
#    the same shape as the host's neuralis/ folder, so the `--neuralis`
#    overlay drops in cleanly. Only the runtime-protected artefacts move
#    into _runtime/ in step 2.
COPY --from=app-builder /src/neuralis/.next/standalone/neuralis/. ./
COPY --from=app-builder /src/neuralis/.next/standalone/node_modules ./node_modules-standalone

# 1b. The operator runbook. Markdown reaches no import graph, so the Next tracer
#     that carries `scripts/` in cannot see `skills/` — it needs saying. Baking it
#     is what lets a pulled image answer "how do I mount a folder / sync a package"
#     from `neuralis://` with no host checkout anywhere: the overlay then swaps in
#     the live copy, and without the overlay this one still resolves.
COPY neuralis/skills ./skills

# 2. Move runtime-protected artefacts into _runtime/:
#    - server.js  → /neuralis/_runtime/server.js
#    - .next/     → /neuralis/_runtime/.next/
#    These survive the whole-folder host overlay via an anonymous volume
#    on /neuralis/_runtime/. Everything else at /neuralis/ root is host-
#    editable when the overlay is on, baked-in when it's off.
#
#    Also COPY package.json into _runtime/ — the bundled Next.js chunks
#    under _runtime/.next/server/chunks/ do `require('../../package.json')`
#    (via `createRequire(import.meta.url)` in `host/builtinSlots.ts`),
#    which now resolves to `_runtime/package.json`. We keep the root
#    /neuralis/package.json too for host-overlay compatibility.
RUN mkdir -p ./_runtime && \
    mv ./server.js ./_runtime/server.js && \
    mv ./.next ./_runtime/.next && \
    cp ./package.json ./_runtime/package.json

# 3. node_modules at /neuralis/node_modules/ — the builder's deploy tree (the
#    graph the Next build compiled against), with the file tracer's copies
#    merged in NO-CLOBBER: the tracer copied from that same tree, so it only
#    ever adds, never replaces.
#    NOT under _runtime/ because skills and tooling reference
#    `node_modules/<name>/skills/...` paths directly;
#    burying it would require a docs/tooling sweep.
#    Node walks UP from server.js (`_runtime/server.js`) for require
#    resolution: `_runtime/node_modules/` (absent) → `/neuralis/node_modules/` ✓.
RUN rm -rf ./node_modules
COPY --from=builder /deploy/node_modules ./node_modules
RUN cp -rn ./node_modules-standalone/. ./node_modules/ && \
    rm -rf ./node_modules-standalone

# 3b. Reconcile Turbopack's external aliases against the node_modules we just
#     assembled. `.next/node_modules/<pkg>-<hash>` is a relative symlink into
#     the BUILDER's pnpm store; the runner only reproduces that path as the
#     file tracer's statically-reachable fragment. Pure-JS externals survive
#     that; a native addon does not — node-pty's `build/Release/pty.node` is
#     loaded through a computed path the tracer cannot see, so the traced copy
#     ships `lib/` alone and every PTY spawn dies while the compiled copy sits
#     unused two directories away. The script retargets each alias at
#     `node_modules/<name>` (deployed, install scripts run) and FAILS THE
#     BUILD if any alias has no flat counterpart, disagrees on major version,
#     or leaves a declared native artifact unloadable. Retargeting also
#     collapses the duplicate `ws`/`esbuild` instances the two trees produced.
COPY neuralis/scripts/build/reconcile-runtime-externals.mjs /tmp/reconcile-runtime-externals.mjs
RUN node /tmp/reconcile-runtime-externals.mjs /neuralis && rm /tmp/reconcile-runtime-externals.mjs

# No build-provenance stamp here, deliberately. "Is this container running what
# I just built?" used to be answered by a file written at this point, which meant
# a second copy of the digest algorithm AND an answer that went stale the moment
# `neuralis:sync` swapped a package. `neuralis:sync` now computes the digest
# INSIDE the running container from the same module the host uses, and takes the
# build time from `docker inspect`, which already knows it.

# 4. Next.js static + public/ → _runtime/ (alongside server.js).
#    Standalone does NOT include `.next/static` or `public/`, so explicit
#    COPYs. Next.js resolves them via `dir = __dirname` (server.js dir),
#    so they belong inside _runtime/. The public/ at /neuralis/public/
#    (from standalone tracer) is harmless duplication — Next.js never
#    looks there.
COPY --from=app-builder /src/neuralis/.next/static ./_runtime/.next/static
COPY --from=app-builder /src/neuralis/public ./_runtime/public

# 4b. The build's own report: the UI-module verdicts, the admission record and —
#     when local packages were built — the lock their dependencies resolved to.
#     `pnpm neuralis:rebuild` copies it out after a green build (it names the
#     refused packages and modules and keeps the lock for the next build). The
#     boot reads `validate.json` (the builtins it leaves out); `ui-compat.json`
#     and the lock are rebuild-side only.
COPY --from=builder /tmp/build-report ./_runtime/build

# 5. /.neuralis dirs use 777 so any UID (compose user: override) can write.
RUN mkdir -p /.neuralis/app /.neuralis/projects && chmod -R 777 /.neuralis

# 6. WORKDIR /neuralis writable for runtime user; _runtime/ and node_modules/
#    stay root:root 755 so they cannot be overwritten by the runtime user.
#    Order matters: chmod runs AFTER all dirs are created so 1777 only
#    touches the /neuralis root, not _runtime/ or node_modules/.
RUN chmod 1777 /neuralis

USER nextjs

EXPOSE 3100 3101

# `NEURALIS_BUILTINS` is no longer baked in — builtinSlots.ts discovers every
# dependency whose package.json carries a `neuralis` block (any scope).
# Override only for slim images that ship fewer builtins (FULL package ids):
#   ENV NEURALIS_BUILTINS=@neuralis/agent-core,@neuralis/brain-core

CMD ["node", "_runtime/server.js"]

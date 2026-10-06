/**
 * docker-compose.yml emission.
 *
 * Extracted from `setup.mts` (S3): the wizard module exports nothing and runs
 * `main()` at load, so the compose emitter — whose network topology and
 * secret-interpolation rules are pinned by tests — has to live outside it,
 * same as the `.env` read-back rules in `envFile.mts` (F3 INC-S1).
 *
 * The compose file is a setup artifact (machine-specific topology), not a
 * tracked product file — same family as .env and platform.json. The generator
 * emits CONCRETE values (UID/GID, ports, URLs) instead of ${VAR:-default}
 * interpolations; the .env values are setup INPUTS, baked in at generation
 * time. The deliberate interpolations are NEXTAUTH_SECRET and QDRANT_API_KEY,
 * which must stay in .env (the compose file must never carry a secret), and —
 * on the monorepo channel only — the two cosmetic build args NEURALIS_VERSION /
 * NEURALIS_REVISION, which `pnpm neuralis:rebuild` sets per build (a value
 * baked here would name the commit setup ran on, not the one being built).
 * Lifecycle rule: this base file is regenerable/disposable on update; the
 * machine-local docker-compose.override.yml (pnpm neuralis:mount) survives
 * updates. See docs/architect/setup-and-update.md.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { feedPrivateScopeRecord, npmrcProblems, planLocalSources, sha256Text } from '../build/build-workspace.mjs';

export type ComposeEmitInput = {
  /** Compose project name — prefixes volumes, networks and container names. */
  composeProject: string;
  uid: number;
  gid: number;
  /** GID owning /var/run/docker.sock, or null → group_add omitted. */
  dockerGid: number | null;
  appPort: number;
  mcpPort: number;
  /** Host-published MCP Apps sandbox-origin port (same container port as the
   *  app — a SECOND published port = a distinct browser origin for the
   *  isolated-origin MCP Apps iframe; MCP1-C). */
  sandboxPort: number;
  nextAuthUrl: string;
  brainInfraMode: 'local' | 'inmemory';
  qdrantMode: 'docker' | 'binary' | 'external' | 'skip';
  /** Host-side Qdrant URL (used for binary/external modes). */
  qdrantUrl: string;
  /**
   * Docker mode: the digest-pinned image of the version this install's storage
   * is ON (`qdrantImageRef(state.version)`, `setup/qdrantVersion.mts`) — never
   * the newest pin, which would start a newer engine on older storage. Only
   * `pnpm neuralis:qdrant-upgrade` advances that state. `null` outside docker
   * mode; docker mode without it is refused, never defaulted.
   */
  qdrantImage: string | null;
  /**
   * Qdrant web dashboard (static SPA at /dashboard). ON by default — the
   * operator flips it via the `.env` `QDRANT_DASHBOARD=off` switch, then
   * `pnpm neuralis:setup --compose-only` + `docker compose up -d`. When off,
   * the qdrant service gets QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false.
   */
  qdrantDashboard: boolean;
  /**
   * Publish the Codex OAuth loopback on the HOST's `127.0.0.1:1455` — operator opt-in
   * `NEURALIS_CODEX_LOOPBACK=on` (the full setup asks it on Docker; `--compose-only`
   * reads `.env`), default off. Docker holds that host port for as long as the stack runs, and `up` fails while another
   * process holds it, so a server install (browser elsewhere) never pays that.
   */
  codexLoopbackPublish: boolean;
  /** Emit the compose-managed ollama service (user picked it during setup). */
  composeOllama: boolean;
  /** Concrete host ~/.neuralis root — the two binds + NEURALIS_HOST_HOME. */
  neuralisHome: string;
  machine: {
    desktopVariant: string;
    image: string;
    containerScope: string;
    idleMinutes: number;
    screen: string;
    sidecarPort: number;
    cdpPort: number;
    seccompUnconfined: boolean;
    dockerSocket: string;
  };
  /** Monorepo dev (workspace detected) → build: block; otherwise image:. */
  monorepo: boolean;
  /**
   * The image channels' exact `neuralisapp/neuralis` tag — install state read
   * from `.env NEURALIS_IMAGE_TAG` (`resolveImageTag`, `setup/envFile.mts`).
   * Ignored on the monorepo channel, which builds; required on every other one.
   */
  imageTag: string | null;
  /**
   * What the monorepo build is handed beside its context (`resolveBuildInputs`):
   * one named context per local package source (`localpkg<slot>`, overriding the
   * Dockerfile's empty stage of that name), the build-state folder (the exported
   * build lock, used when it fits the tracked lock, and the private-scope record),
   * and the operator's `.npmrc` as a BuildKit secret — a path,
   * never its content. Ignored on the image channels, which never build.
   */
  build: BuildInputs;
  /**
   * Host-access plane (native-nightjar). When the operator has provisioned the
   * broker, compose bind-mounts its runtime directory (Unix socket + secret)
   * read-only into the app container. THIS BIND IS THE REAL GATE: no in-app
   * role can add a mount or start a host unit, so an attacker who flips every
   * reachable setting still cannot reach the host plane.
   */
  hostBroker: {
    enabled: boolean;
    /** Host path of the broker's Unix socket. */
    socketPath: string;
    /** Host path of the operator-owned shared-secret file. */
    secretFile: string;
  };
};

export type BuildInputs = {
  localSources: ReadonlyArray<{ slot: number; name: string; contextDir: string }>;
  buildLockDir: string | null;
  npmrcFile: string | null;
};

export const NO_BUILD_INPUTS: BuildInputs = { localSources: [], buildLockDir: null, npmrcFile: null };

/**
 * The build inputs of THIS machine, derived and checked before a compose file
 * is written: the host manifest's `file:`/`link:` dependencies (slot order and
 * rules: `scripts/build/build-workspace.mjs`), the build lock a green build
 * exported to `<neuralisHome>/build/` (fed back when it was resolved over the
 * same tracked `pnpm-lock.yaml` and a local package exists), the private-scope
 * record beside it (fed HERE from the `.npmrc` and the kept lock before the
 * build can replace that lock; the folder is fed back whenever it holds one), and
 * `.env NEURALIS_BUILD_NPMRC`. Throws, naming every problem, so a rebuild
 * stops before Docker instead of failing minutes into the build.
 */
export function resolveBuildInputs(params: {
  hostDir: string;
  repoRoot: string;
  neuralisHome: string;
  npmrcPath: string | undefined;
}): BuildInputs {
  const errors: string[] = [];
  const hostManifest = JSON.parse(readFileSync(join(params.hostDir, 'package.json'), 'utf-8')) as unknown;
  const plan = planLocalSources(hostManifest, params.hostDir, { existsSync, statSync, realpathSync });
  errors.push(...plan.errors);

  let npmrcFile: string | null = null;
  let npmrcText = '';
  const npmrc = params.npmrcPath?.trim();
  if (npmrc) {
    if (!existsSync(npmrc) || !statSync(npmrc).isFile()) {
      errors.push(`.env NEURALIS_BUILD_NPMRC=${npmrc} — no such file`);
    } else {
      npmrcText = readFileSync(npmrc, 'utf-8');
      const problems = npmrcProblems(npmrcText);
      errors.push(...problems.map((p) => `.env NEURALIS_BUILD_NPMRC (${npmrc}) ${p}`));
      npmrcFile = npmrc;
    }
  }

  let buildLockDir: string | null = null;
  const lockDir = join(params.neuralisHome, 'build');
  const keptLock = join(lockDir, 'pnpm-lock.yaml');
  const trackedLock = join(params.repoRoot, 'pnpm-lock.yaml');
  let recordedScopes = 0;
  try {
    const lockTexts = existsSync(keptLock) ? [readFileSync(keptLock, 'utf-8')] : [];
    recordedScopes = feedPrivateScopeRecord(lockDir, { npmrcText, lockTexts }).size;
  } catch (err) {
    errors.push(`the private-scope record: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (plan.sources.length > 0 && existsSync(keptLock) && existsSync(trackedLock)) {
    const recorded = existsSync(join(lockDir, 'tracked-lock.sha256'))
      ? readFileSync(join(lockDir, 'tracked-lock.sha256'), 'utf-8').trim()
      : '';
    if (recorded === sha256Text(readFileSync(trackedLock, 'utf-8'))) buildLockDir = lockDir;
  }
  // The record must reach the build's scope check even when the lock is not used.
  if (recordedScopes > 0) buildLockDir = lockDir;

  if (errors.length > 0) {
    throw new Error(`the build inputs are not usable:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return {
    localSources: plan.sources.map((s) => ({ slot: s.slot, name: s.name, contextDir: s.contextDir })),
    buildLockDir,
    npmrcFile,
  };
}

/**
 * Pinned ollama image for the optional compose-managed service (never `latest`):
 * tag + manifest-list digest, so a moved tag cannot change what a regenerated
 * compose pulls. Refresh: `docker buildx imagetools inspect ollama/ollama:<tag>`.
 */
export const OLLAMA_IMAGE =
  'ollama/ollama:0.35.0@sha256:2a6e883b917fc543389599dae79918f5cac9e1438890506982f44aa4f5625d01';
/**
 * The community-edition image at one exact tag. The org segment is `neuralisapp` —
 * OUR Docker Hub namespace. Never emit a bare `neuralis/…` form here: that
 * namespace is foreign, so a generated compose file naming it would pull whatever
 * an unrelated account publishes under it. Never a moving tag either: the tag is
 * the release this install runs, and only `neuralis:update` (or the operator's
 * `.env` edit) moves it.
 */
export function communityImage(tag: string): string {
  return `neuralisapp/neuralis:${tag}`;
}

/**
 * Rewrites a loopback URL into a form the neuralis container can reach when
 * running in docker. Setup runs from the host shell where `127.0.0.1` points
 * at the host itself; inside the container the same literal points at the
 * container's own loopback. `host.docker.internal` is the bridge — paired
 * with `extra_hosts: host.docker.internal:host-gateway` in docker-compose.
 *
 * Leaves external hosts, already-host.docker.internal URLs, and compose
 * service names untouched.
 */
export function hostReachableUrl(url: string, mode: 'native' | 'docker'): string {
  if (mode === 'native' || !url) return url;
  // Cheap literal swap — preserves the caller's path + trailing-slash shape.
  return url
    .replace(/^(https?:\/\/)127\.0\.0\.1(?=[:/]|$)/i, '$1host.docker.internal')
    .replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1host.docker.internal');
}

export function buildComposeContent(input: ComposeEmitInput, stamp: { date: string; version: string }): string {
  const m = input.machine;
  const lines: string[] = [
    `# GENERATED by pnpm neuralis:setup (${stamp.date}, neuralis ${stamp.version}) — do not hand-edit.`,
    '# Re-run setup (or `pnpm neuralis:setup --compose-only`) to regenerate after',
    '# changing .env or topology. Values are emitted concrete on purpose: this file',
    '# is machine-specific and gitignored; .env holds the setup inputs. The kept',
    '# interpolations are NEXTAUTH_SECRET and QDRANT_API_KEY — both secrets live in',
    '# .env, never here — and the build args `pnpm neuralis:rebuild` sets per build.',
    '# Machine-local mounts + the --neuralis overlay live in docker-compose.override.yml',
    '# (written by `pnpm neuralis:mount`, auto-merged by Compose — survives updates).',
    '',
    '# Explicit project name: the file location is channel-dependent; without this a',
    '# directory move would re-prefix the named volumes and orphan qdrant-data.',
    `name: ${input.composeProject}`,
    '',
    'services:',
    '  # ── App (Next.js — API + UI + embedded brain) ─────────────────',
    '  neuralis:',
  ];

  if (input.monorepo) {
    lines.push(
      '    build:',
      '      context: ..',
      '      dockerfile: neuralis/Dockerfile',
      '      # Version + commit shown in the admin environment table and the image',
      '      # labels. Cosmetic: `pnpm neuralis:rebuild` sets both per build.',
      '      args:',
      '        NEURALIS_VERSION: ${NEURALIS_VERSION:-0.0.0-dev}',
      '        NEURALIS_REVISION: ${NEURALIS_REVISION:-unknown}',
    );
    const contexts = [
      ...input.build.localSources.map((s) => [`localpkg${s.slot}`, s.contextDir, s.name] as const),
      ...(input.build.buildLockDir ? [['buildlock', input.build.buildLockDir, 'the exported build lock + private-scope record'] as const] : []),
    ];
    if (contexts.length > 0) {
      lines.push(
        '      # Local package sources (file: dependencies of neuralis/package.json) and',
        '      # the exported build lock, each overriding the Dockerfile stage of its name.',
        '      additional_contexts:',
        ...contexts.map(([key, dir, what]) => `        ${key}: ${JSON.stringify(dir)} # ${what}`),
      );
    }
    if (input.build.npmrcFile) {
      lines.push(
        '      # The private-registry .npmrc, mounted for the install/deploy steps only —',
        '      # a BuildKit secret, never a layer (.env NEURALIS_BUILD_NPMRC).',
        '      secrets:',
        '        - npmrc',
        '      # A registry on THIS machine is reached from the build the way the app',
        '      # reaches host services: http://host.docker.internal:<port> in the .npmrc.',
        '      extra_hosts:',
        '        - "host.docker.internal:host-gateway"',
      );
    }
  } else {
    if (!input.imageTag) throw new Error('image-channel compose needs the recorded NEURALIS_IMAGE_TAG; none was resolved.');
    lines.push(`    image: ${communityImage(input.imageTag)}`);
  }

  lines.push(`    user: "${input.uid}:${input.gid}"`);

  if (input.dockerGid !== null) {
    lines.push(
      '    # Host docker-group GID as a supplementary group so the non-root app user',
      '    # can access the bind-mounted /var/run/docker.sock (machine-core).',
      '    group_add:',
      `      - "${input.dockerGid}"`,
    );
  } else {
    lines.push(
      '    # /var/run/docker.sock owner GID was not detected on this host — group_add',
      '    # omitted; the machine widget surfaces a clean "docker-missing" error.',
    );
  }

  lines.push(
    '    ports:',
    `      - "${input.appPort}:3100"`,
    `      - "${input.mcpPort}:3101"`,
    '      # MCP Apps sandbox origin (MCP1-C): the SAME app port published a',
    '      # second time — the browser treats hostname:sandboxPort as a distinct',
    '      # origin; the host proxy serves ONLY /mcp-sandbox on it.',
    `      - "${input.sandboxPort}:3100"`,
  );
  if (input.codexLoopbackPublish) {
    lines.push(
      '      # Codex OAuth loopback callback (.env NEURALIS_CODEX_LOOPBACK=on): the',
      '      # IdP redirects the browser to localhost:1455, which on this shape is the',
      '      # HOST loopback. Published there and only there — the listener is',
      '      # pre-auth by construction, so never a LAN bind.',
      '      - "127.0.0.1:1455:1455"',
    );
  }
  lines.push(
    '    # Give the SIGTERM stream-drain time to finalize+persist in-flight agent',
    '    # turns before Compose escalates to SIGKILL on recreate/stop/restart',
    '    # (drain bound is ~25s; headroom on top). Prevents the running turn from',
    '    # vanishing from messages.jsonl on `docker compose up -d --build -V`.',
    '    stop_grace_period: 40s',
    '    # Resolve host-side services (e.g. a native Ollama) from inside the',
    '    # container via host.docker.internal.',
    '    extra_hosts:',
    '      - "host.docker.internal:host-gateway"',
    '    volumes:',
    `      - ${input.neuralisHome}/app:/.neuralis/app`,
    `      - ${input.neuralisHome}/projects:/.neuralis/projects`,
    '      # machine-core: host Docker socket so MachineSessionManager can spawn',
    '      # per-user Webtop containers. Remove to disable the machine widget.',
    '      - /var/run/docker.sock:/var/run/docker.sock',
  );

  if (input.hostBroker.enabled) {
    lines.push(
      '      # native-nightjar host plane — mount the broker runtime DIRECTORY',
      '      # read-only. A broker restart may replace the socket inode; mounting',
      '      # only the socket file would leave the container bound to a stale one.',
      '      # Removing this bind disables the plane; no app role can recreate it.',
      `      - ${dirname(input.hostBroker.socketPath)}:/run/neuralis/host-broker:ro`,
    );
  }

  if (input.qdrantMode === 'docker') {
    lines.push(
      '    # The app spans BOTH networks; Qdrant sits only on its own (see the',
      '    # top-level networks block).',
      '    networks:',
      '      - default',
      '      - qdrant',
    );
  }

  lines.push(
    '    env_file:',
    '      - path: .env',
    '        required: false',
    '    environment:',
    '      - NODE_ENV=production',
    '      - NEURALIS_DOCKER=true',
    // Always explicit, so it overrides the env_file copy: the in-container
    // listener binds 0.0.0.0 only when THIS file publishes 1455 — an `.env`
    // flipped to `on` without the regen must not open it to the compose network.
    `      - NEURALIS_CODEX_LOOPBACK=${input.codexLoopbackPublish ? 'on' : 'off'}`,
    '      - NEURALIS_HOME=/.neuralis',
    '      # Host-pair root: lets LocalDiskConnector.resolveOsUri translate container',
    '      # paths back to host paths for vectors and UI.',
    `      - NEURALIS_HOST_HOME=${input.neuralisHome}`,
    `      - NEXTAUTH_URL=${input.nextAuthUrl}`,
    '      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET:?Run pnpm neuralis:setup first}',
    `      - BRAIN_INFRA_MODE=${input.brainInfraMode}`,
    '      # 1 = colour-coded, uri-aware line per meaningful Qdrant vector op to',
    "      # this container log (writes + searches; scroll suppressed). 'all' adds",
    '      # scroll. Dev affordance; off in prod.',
    '      - BRAIN_VECTOR_LOG_CONSOLE=${BRAIN_VECTOR_LOG_CONSOLE:-0}',
  );

  if (input.hostBroker.enabled) {
    lines.push(
      '      # The container reads the shared secret from this FILE, never from',
      '      # platform config: `PATCH /config` sits behind the project-scoped',
      '      # `platform.config` feature, so a secret stored there would be readable',
      '      # and writable by any project owner.',
      '      - NEURALIS_HOST_BROKER_SECRET_FILE=/run/neuralis/host-broker/secret',
    );
  }

  if (input.qdrantMode === 'docker') {
    lines.push('      - QDRANT_URL=http://qdrant:6333');
  } else if (input.qdrantMode === 'binary' || input.qdrantMode === 'external') {
    lines.push(`      - QDRANT_URL=${hostReachableUrl(input.qdrantUrl || 'http://localhost:6333', 'docker')}`);
  }
  // qdrantMode 'skip' → no QDRANT_URL (BRAIN_INFRA_MODE=inmemory covers it).

  lines.push(
    `      - MCP_HTTP_PORT=${input.mcpPort}`,
    '      # MCP Apps isolated-origin sandbox port (browser-visible published',
    '      # port). Read by the host proxy (sandbox-origin fence) and the',
    '      # mcp-apps/template route; unset ⇒ the card fails closed (no srcdoc).',
    `      - NEURALIS_MCP_SANDBOX_PORT=${input.sandboxPort}`,
    '      # machine-core (LinuxServer Webtop + KasmVNC + Playwright-over-CDP)',
    `      - NEURALIS_MACHINE_DOCKER_SOCKET=${m.dockerSocket}`,
    `      - NEURALIS_MACHINE_IMAGE=${m.image}`,
    `      - NEURALIS_MACHINE_CONTAINER_SCOPE=${m.containerScope}`,
    `      - NEURALIS_MACHINE_IDLE_MINUTES=${m.idleMinutes}`,
    `      - NEURALIS_MACHINE_SCREEN=${m.screen}`,
    `      - NEURALIS_MACHINE_DESKTOP_VARIANT=${m.desktopVariant}`,
    `      - NEURALIS_MACHINE_SIDECAR_PORT=${m.sidecarPort}`,
    `      - NEURALIS_MACHINE_CDP_PORT=${m.cdpPort}`,
    `      - NEURALIS_MACHINE_SECCOMP_UNCONFINED=${m.seccompUnconfined}`,
    '      # Deterministic webtop/sidecar network pin: child containers join the',
    '      # compose DEFAULT network by name, never the qdrant one — with two',
    '      # user-defined networks on the app container, first-key detection',
    '      # would be name-luck, not a contract.',
    `      - NEURALIS_MACHINE_SHARED_NETWORK=${input.composeProject}_default`,
  );

  if (input.qdrantMode === 'docker') {
    lines.push(
      '    depends_on:',
      '      qdrant:',
      '        condition: service_healthy',
      '        required: false',
    );
  }

  lines.push(
    '    # Readiness: /api/health is 200 only once the in-process agent-core',
    '    # bootstrap completes — not merely when the HTTP server binds.',
    '    healthcheck:',
    `      test: ["CMD-SHELL", "node -e \\"fetch('http://localhost:3100/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))\\""]`,
    '      interval: 15s',
    '      timeout: 5s',
    '      retries: 5',
    '      start_period: 50s',
    '    restart: unless-stopped',
    '    # neuralis.* labels let a future label-scoped prune target ONLY Neuralis',
    '    # resources (never a blanket prune of a shared/enterprise host).',
    '    labels:',
    '      neuralis.kind: "app"',
  );

  if (input.qdrantMode === 'docker') {
    if (!input.qdrantImage) throw new Error('docker-mode compose needs the recorded Qdrant image; none was resolved.');
    lines.push(
      '',
      '  # ── Qdrant (Vector DB — the core knowledge store) ────────────',
      '  # The image is the version the storage of THIS install is on, digest-',
      '  # pinned (recorded in <NEURALIS_HOME>/qdrant-version.json). Qdrant',
      '  # storage is forward-only and upgrades one minor at a time, so never',
      '  # edit this line: `pnpm neuralis:qdrant-upgrade` walks every minor with',
      '  # a cold backup and a rollback, then regenerates this file.',
      '  # Recovery is that backup, never `down -v` (that deletes the',
      '  # qdrant-data volume and every embedding with it — re-embedding is the',
      '  # only way back, and it costs real provider spend).',
      '  qdrant:',
      `    image: ${input.qdrantImage}`,
      '    ports:',
      '      - "127.0.0.1:6333:6333"',
      '    volumes:',
      '      - qdrant-data:/qdrant/storage',
      '      # Snapshots outside the container layer, so one survives a recreate.',
      '      - qdrant-snapshots:/qdrant/snapshots',
      '    # Own network only: the app reaches Qdrant over the qdrant network;',
      '    # webtop/sidecar containers (on the default network) cannot.',
      '    networks:',
      '      - qdrant',
      '    environment:',
      '      # Keep Qdrant own INFO, but silence the per-request actix access-log',
      '      # spam (every upsert/scroll/delete logged identically). The meaningful,',
      '      # uri-aware op log lives host-side (BRAIN_VECTOR_LOG_CONSOLE).',
      '      - QDRANT__LOG_LEVEL=info,actix_web::middleware::logger=warn',
      '      # Server-side API key: EVERY request must carry it (only /healthz,',
      '      # /readyz, /livez, / and the dashboard statics are exempt upstream).',
      '      # The value stays in .env — the compose file never carries a secret.',
      '      - QDRANT__SERVICE__API_KEY=${QDRANT_API_KEY:?Run pnpm neuralis:setup (the key lives in .env)}',
      '      # On-prem: no phone-home. Qdrant reports anonymous usage upstream',
      '      # unless told not to.',
      '      - QDRANT__TELEMETRY_DISABLED=true',
    );
    if (!input.qdrantDashboard) {
      lines.push(
        '      # Operator switch: .env QDRANT_DASHBOARD=off disables the static',
        '      # web UI entirely (the API is unaffected).',
        '      - QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false',
      );
    }
    lines.push(
      '    healthcheck:',
      `      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/6333'"]`,
      '      interval: 10s',
      '      timeout: 5s',
      '      retries: 5',
      '      start_period: 15s',
      '    logging:',
      '      driver: json-file',
      '      options:',
      '        max-size: "10m"',
      '        max-file: "3"',
      '    restart: unless-stopped',
      '    labels:',
      '      neuralis.kind: "vectorstore"',
    );
  }

  if (input.composeOllama) {
    lines.push(
      '',
      '  # ── Ollama (compose-managed local embeddings / local LLM) ────',
      '  # No networks: key — ollama joins the DEFAULT network (never the qdrant',
      '  # one; it has no business with the vector store).',
      '  ollama:',
      `    image: ${OLLAMA_IMAGE}`,
      '    ports:',
      '      - "11434:11434"',
      '    volumes:',
      '      - ollama-data:/root/.ollama',
      '    # Soft limit: guaranteed 2g, may grow while the host has free memory;',
      '    # hard cap at 6g so a large model can never starve the rest of the VM.',
      '    mem_reservation: 2g',
      '    mem_limit: 6g',
      '    restart: unless-stopped',
      '    labels:',
      '      neuralis.kind: "embeddings"',
    );
  }

  if (input.qdrantMode === 'docker') {
    lines.push(
      '',
      '# Two networks, one boundary: the app spans both; Qdrant sits ONLY on its',
      '# own. Webtop/sidecar child containers join <project>_default (the',
      '# NEURALIS_MACHINE_SHARED_NETWORK pin above), so a virtual desktop shell',
      '# can never reach the vector store — the Qdrant API key is the second,',
      '# independent layer on the same data.',
      'networks:',
      '  default:',
      '    driver: bridge',
      '  qdrant:',
      '    driver: bridge',
    );
  }

  const volumeLines: string[] = [];
  // The named volumes are DELIBERATELY not given a custom `neuralis.*` label. Compose
  // already tags every resource it creates with `com.docker.compose.project=neuralis`
  // (what tooling addressing containers by name depends on), so a custom volume label is redundant —
  // AND adding one to an EXISTING volume makes `docker compose up` emit the interactive
  // `Volume "…" exists but doesn't match configuration … Recreate (data will be lost)?`
  // prompt, which hangs a non-interactive rebuild and risks wiping qdrant-data on a
  // reflexive "y" (live-verified 2026-07-14). Service labels are safe (containers
  // recreate freely); volume labels are not. The vector store is protected from
  // `docker volume prune` by being ATTACHED regardless.
  if (input.qdrantMode === 'docker') {
    volumeLines.push('  qdrant-data:', '    driver: local', '  qdrant-snapshots:', '    driver: local');
  }
  if (input.composeOllama) volumeLines.push('  ollama-data:', '    driver: local');
  if (volumeLines.length > 0) {
    lines.push('', 'volumes:', ...volumeLines);
  }

  if (input.monorepo && input.build.npmrcFile) {
    lines.push('', 'secrets:', '  npmrc:', `    file: ${JSON.stringify(input.build.npmrcFile)}`);
  }

  return lines.join('\n') + '\n';
}

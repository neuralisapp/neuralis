/**
 * The generated docker-compose.yml's security topology (S3).
 *
 * Every pin here is a red-first control: each was verified to go red when the
 * emission it guards is removed. The subjects, in the order the plan names
 * them: the Qdrant API-key interpolation (the compose file carries the
 * `${QDRANT_API_KEY:?}` reference, NEVER the value), the two-network topology
 * (qdrant on its own network, the app on both, ollama on the default), the
 * deterministic `NEURALIS_MACHINE_SHARED_NETWORK` pin, the dashboard switch,
 * and the byte-stable qdrant-data volume declaration (B5 — any drift in those
 * bytes makes `docker compose up` prompt to RECREATE the volume, which hangs
 * a non-interactive rebuild and can wipe every embedding on a reflexive "y").
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NO_BUILD_INPUTS, buildComposeContent, operatorDependencies, planOperatorImage, resolveBuildInputs, type ComposeEmitInput } from '../setup/compose.mts';
import { packageBindTarget } from '../mount/packageBind.mts';
import { qdrantImageRef } from '../setup/qdrantVersion.mts';

const STAMP = { date: '2026-08-23', version: '0.1.0' };

function baseInput(overrides: Partial<ComposeEmitInput> = {}): ComposeEmitInput {
  return {
    composeProject: 'neuralis',
    uid: 1000,
    gid: 1000,
    dockerGid: 990,
    appPort: 3100,
    mcpPort: 3101,
    sandboxPort: 3102,
    nextAuthUrl: 'http://localhost:3100',
    brainInfraMode: 'local',
    qdrantMode: 'docker',
    qdrantUrl: 'http://localhost:6333',
    qdrantPort: 6333,
    qdrantImage: qdrantImageRef('1.13.6'),
    qdrantDashboard: true,
    codexLoopbackPublish: false,
    composeOllama: true,
    neuralisHome: '/home/op/.neuralis',
    machine: {
      desktopVariant: 'ubuntu-xfce',
      image: 'neuralisapp/webtop-ubuntu-xfce:dev',
      containerScope: 'user',
      idleMinutes: 30,
      screen: '1920x1080',
      sidecarPort: 9400,
      cdpPort: 9222,
      seccompUnconfined: false,
      dockerSocket: '/var/run/docker.sock',
    },
    monorepo: true,
    imageTag: null,
    hostBroker: { enabled: false, socketPath: '/x/host-broker.sock', secretFile: '/x/secret' },
    build: NO_BUILD_INPUTS,
    operatorImage: null,
    ...overrides,
  };
}

describe('custom published MCP port', () => {
  it('maps the chosen host port to the fixed companion listener in every install channel', () => {
    for (const monorepo of [true, false]) {
      const content = buildComposeContent(baseInput({ mcpPort: 43393, monorepo, imageTag: '0.2.1' }), STAMP);
      expect(content).toContain('      - "43393:3101"\n');
      expect(content).toContain('      - MCP_HTTP_PORT=3101\n');
      expect(content).not.toContain('      - MCP_HTTP_PORT=43393\n');
    }
  });
});

/** The service block for `name:` — from its header to the next top-level-ish key. */
function serviceBlock(content: string, name: string): string {
  const start = content.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name} present`).toBeGreaterThan(-1);
  const rest = content.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n')).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + rest.indexOf('\n'));
}

describe('the Qdrant host port (NEURALIS_QDRANT_PORT)', () => {
  it('publishes the chosen loopback port onto the fixed container port; the app still reaches it inside', () => {
    const content = buildComposeContent(baseInput({ qdrantPort: 6334 }), STAMP);
    expect(serviceBlock(content, 'qdrant')).toContain('      - "127.0.0.1:6334:6333"\n');
    expect(content).not.toContain('127.0.0.1:6333:6333');
    expect(content).toContain('      - QDRANT_URL=http://qdrant:6333\n');
    expect(serviceBlock(content, 'qdrant')).toContain("/dev/tcp/localhost/6333'");
    expect(buildComposeContent(baseInput(), STAMP)).toContain('      - "127.0.0.1:6333:6333"\n');
  });
});

describe('Qdrant API key — interpolation, never a value', () => {
  it('hands the key to the qdrant service via ${QDRANT_API_KEY:?} (docker mode)', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    // eslint-disable-next-line no-template-curly-in-string
    expect(content).toContain('- QDRANT__SERVICE__API_KEY=${QDRANT_API_KEY:?');
  });

  it('the compose file never carries a literal key value', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    // Every QDRANT__SERVICE__API_KEY occurrence must be the interpolation form.
    for (const line of content.split('\n').filter((l) => l.includes('QDRANT__SERVICE__API_KEY'))) {
      // eslint-disable-next-line no-template-curly-in-string
      expect(line).toContain('=${QDRANT_API_KEY:?');
    }
  });

  it('the qdrant service has telemetry OFF (on-prem, no phone-home)', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'qdrant');
    expect(block).toContain('      - QDRANT__TELEMETRY_DISABLED=true\n');
  });

  it('non-docker modes emit no qdrant service and no server-side key line', () => {
    const content = buildComposeContent(baseInput({ qdrantMode: 'external' }), STAMP);
    expect(content).not.toContain('QDRANT__SERVICE__API_KEY');
  });
});

describe('network topology — qdrant isolated, app dual-homed, ollama on default', () => {
  it('declares both networks top-level in docker mode', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    expect(content).toMatch(/\nnetworks:\n(?:.*\n)*? {2}default:\n {4}driver: bridge\n/);
    expect(content).toMatch(/\nnetworks:\n(?:.*\n)*? {2}qdrant:\n {4}driver: bridge\n/);
  });

  it('the qdrant service sits ONLY on the qdrant network', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'qdrant');
    expect(block).toMatch(/ {4}networks:\n {6}- qdrant\n/);
    expect(block).not.toMatch(/ {6}- default\n/);
  });

  it('the app service spans default AND qdrant', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'neuralis');
    expect(block).toMatch(/ {4}networks:\n {6}- default\n {6}- qdrant\n/);
  });

  it('the ollama service carries NO networks key (falls to the default network)', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'ollama');
    expect(block).not.toContain('networks:');
  });

  it('no networks block outside docker mode (single implicit default)', () => {
    const content = buildComposeContent(baseInput({ qdrantMode: 'external' }), STAMP);
    expect(content).not.toMatch(/\nnetworks:\n/);
  });
});

describe('the deterministic webtop/sidecar network pin', () => {
  it('emits NEURALIS_MACHINE_SHARED_NETWORK=<project>_default into the app env', () => {
    const content = buildComposeContent(baseInput({ composeProject: 'neuralis-lab' }), STAMP);
    expect(content).toContain('- NEURALIS_MACHINE_SHARED_NETWORK=neuralis-lab_default');
  });
});

describe('the dashboard switch (QDRANT_DASHBOARD)', () => {
  it('off ⇒ the qdrant service gets ENABLE_STATIC_CONTENT=false', () => {
    const content = buildComposeContent(baseInput({ qdrantDashboard: false }), STAMP);
    expect(content).toContain('- QDRANT__SERVICE__ENABLE_STATIC_CONTENT=false');
  });

  it('on ⇒ the line is NOT emitted (upstream default keeps the dashboard)', () => {
    const content = buildComposeContent(baseInput({ qdrantDashboard: true }), STAMP);
    expect(content).not.toContain('QDRANT__SERVICE__ENABLE_STATIC_CONTENT');
  });
});

describe('B5 — the qdrant-data volume declaration is byte-stable', () => {
  it('emits exactly the historical bytes', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    // Any change to these bytes makes `docker compose up` interactively offer
    // to RECREATE the existing volume (data loss). Byte-for-byte, on purpose.
    expect(content).toContain('\nvolumes:\n  qdrant-data:\n    driver: local\n');
    expect(content).not.toMatch(/qdrant-data:\n {4}(?!driver: local)/);
    expect(content.match(/^ {2}qdrant-data:$/m)?.length).toBe(1);
  });

  it('the volume keeps no custom labels (label drift = recreate prompt)', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    const volumesAt = content.lastIndexOf('\nvolumes:\n');
    expect(content.slice(volumesAt)).not.toContain('labels');
  });
});

describe('the Qdrant image is the RECORDED version, digest-pinned', () => {
  it('renders exactly the image it is handed — never a newer code constant', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'qdrant');
    expect(block).toContain(
      '    image: qdrant/qdrant:v1.13.6@sha256:bd67306b6cc77c98122cada2321eb60b20d00b19d26cb61c86681e7bd5951498\n',
    );
    const upgraded = serviceBlock(buildComposeContent(baseInput({ qdrantImage: qdrantImageRef('1.19.1') }), STAMP), 'qdrant');
    expect(upgraded).toContain('    image: qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10\n');
  });

  it('docker mode without a resolved image is refused, never defaulted', () => {
    expect(() => buildComposeContent(baseInput({ qdrantImage: null }), STAMP)).toThrow(/recorded Qdrant image/);
    expect(() => buildComposeContent(baseInput({ qdrantMode: 'external', qdrantImage: null }), STAMP)).not.toThrow();
  });

  it('snapshots live on their own named volume, so one survives a recreate', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    expect(serviceBlock(content, 'qdrant')).toContain('      - qdrant-snapshots:/qdrant/snapshots\n');
    expect(content).toContain('\n  qdrant-snapshots:\n    driver: local\n');
  });
});

describe('the app healthcheck', () => {
  it('probes /api/health with wget — one small fork per probe, no node process', () => {
    const block = serviceBlock(buildComposeContent(baseInput(), STAMP), 'neuralis');
    expect(block).toContain('      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3100/api/health || exit 1"]\n');
    expect(block).not.toContain('node -e');
  });
});

describe('the image channel pins ONE exact release — never a moving tag', () => {
  it('emits neuralisapp/neuralis:<the recorded tag>, and the word `latest` appears nowhere', () => {
    const content = buildComposeContent(baseInput({ monorepo: false, imageTag: '0.1.0' }), STAMP);
    expect(serviceBlock(content, 'neuralis')).toContain('    image: neuralisapp/neuralis:0.1.0\n');
    expect(content).not.toMatch(/latest/);
  });

  it('renders exactly the tag it is handed — an older install keeps its own release', () => {
    const content = buildComposeContent(baseInput({ monorepo: false, imageTag: '0.0.9' }), STAMP);
    expect(content).toContain('    image: neuralisapp/neuralis:0.0.9\n');
    expect(content).not.toContain('neuralisapp/neuralis:0.1.0');
  });

  it('the image channel without a recorded tag is refused, never defaulted', () => {
    expect(() => buildComposeContent(baseInput({ monorepo: false, imageTag: null }), STAMP)).toThrow(/NEURALIS_IMAGE_TAG/);
  });

  it('the monorepo channel builds and names no image of its own', () => {
    const content = buildComposeContent(baseInput({ monorepo: true, imageTag: null }), STAMP);
    expect(content).not.toContain('neuralisapp/neuralis:');
    expect(serviceBlock(content, 'neuralis')).toContain('    build:\n');
  });
});

describe('the Codex loopback callback port (operator opt-in)', () => {
  it('by default publishes NOTHING on 1455 and tells the listener so — Docker would hold the host port while the stack runs', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    expect(content).not.toMatch(/1455/);
    expect(content).toContain('      - NEURALIS_CODEX_LOOPBACK=off\n');
  });

  it('opted in, it publishes 1455 on the HOST LOOPBACK only — never a LAN or all-interfaces bind', () => {
    const content = buildComposeContent(baseInput({ codexLoopbackPublish: true }), STAMP);
    expect(content).toContain('      - "127.0.0.1:1455:1455"\n');
    expect(content).not.toMatch(/^\s*- "1455:1455"/m);
    expect(content).not.toMatch(/0\.0\.0\.0:1455/);
    expect(content.match(/1455:1455/g)?.length).toBe(1);
  });

  it('opted in, the environment block carries the explicit `on` next to NEURALIS_DOCKER=true — it overrides the env_file copy', () => {
    const content = buildComposeContent(baseInput({ codexLoopbackPublish: true }), STAMP);
    expect(content).toContain('      - NEURALIS_DOCKER=true\n      - NEURALIS_CODEX_LOOPBACK=on\n');
  });
});

describe('the monorepo build inputs — named contexts and the .npmrc secret', () => {
  const sources = [
    { slot: 0, name: '@acme/probe', contextDir: '/home/op/work/acme probe' },
    { slot: 1, name: 'plain-probe', contextDir: '/home/op/tarballs' },
  ];

  it('no local package and no secret: no additional_contexts, no secrets — the build block is unchanged', () => {
    const content = buildComposeContent(baseInput(), STAMP);
    expect(content).not.toContain('additional_contexts:');
    expect(content).not.toMatch(/^\s*secrets:/m);
  });

  it('one localpkg<slot> context per registered local package, the path JSON-quoted (spaces survive)', () => {
    const block = serviceBlock(buildComposeContent(baseInput({ build: { ...NO_BUILD_INPUTS, localSources: sources } }), STAMP), 'neuralis');
    expect(block).toContain('      additional_contexts:\n');
    expect(block).toContain('        localpkg0: "/home/op/work/acme probe" # @acme/probe\n');
    expect(block).toContain('        localpkg1: "/home/op/tarballs" # plain-probe\n');
    const keys = [...block.matchAll(/^ {8}(localpkg\d+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['localpkg0', 'localpkg1']);
  });

  it('the exported build lock rides as the `buildlock` context', () => {
    const content = buildComposeContent(
      baseInput({ build: { localSources: sources.slice(0, 1), buildLockDir: '/home/op/.neuralis/build', npmrcFile: null } }),
      STAMP,
    );
    expect(content).toContain('        buildlock: "/home/op/.neuralis/build" # the exported build lock + private-scope record\n');
  });

  it('the .npmrc is a build SECRET by path — named in build.secrets and the top-level secrets block, never inlined', () => {
    const content = buildComposeContent(baseInput({ build: { ...NO_BUILD_INPUTS, npmrcFile: '/home/op/.npmrc-build' } }), STAMP);
    expect(content).toContain('      secrets:\n        - npmrc\n');
    expect(serviceBlock(content, 'neuralis')).toMatch(/ {6}extra_hosts:\n {8}- "host\.docker\.internal:host-gateway"\n/);
    expect(content).toContain('\nsecrets:\n  npmrc:\n    file: "/home/op/.npmrc-build"\n');
    expect(content).not.toMatch(/_authToken/);
  });

  it('an image channel with no derived image never builds: no build block, so no contexts and no secret even when inputs exist', () => {
    const content = buildComposeContent(
      baseInput({ monorepo: false, imageTag: '0.1.0', build: { localSources: sources, buildLockDir: '/x', npmrcFile: '/y' } }),
      STAMP,
    );
    expect(content).not.toContain('additional_contexts:');
    expect(content).not.toMatch(/^secrets:/m);
  });
});

describe('the generated compose carries no plan names (it is shipped, operator-read text)', () => {
  it('the host-plane comment says what the bind is, never a round codename', () => {
    const content = buildComposeContent(baseInput({ hostBroker: { enabled: true, socketPath: '/x/host-broker.sock', secretFile: '/x/secret' } }), STAMP);
    expect(content).toContain('# The host-access plane — mount the broker runtime DIRECTORY');
    expect(content).not.toMatch(/nightjar/);
  });
});

describe('the npm install folder runs ONE derived image when it registers operator packages', () => {
  const folder = (deps: Record<string, string>) => ({ private: true, dependencies: { neuralis: '0.2.0', ...deps } });
  const plan = (manifest: unknown, over: Partial<Parameters<typeof planOperatorImage>[0]> = {}) =>
    planOperatorImage({
      installManifest: manifest,
      contextDir: '/home/op/install/operator-image',
      composeProject: 'neuralis',
      imageTag: '0.2.0',
      build: NO_BUILD_INPUTS,
      readBuildHelper: () => '// the build helper\n',
      ...over,
    });

  it('the operator packages are every line of the folder manifest but `neuralis`; the host package itself has none', () => {
    expect(operatorDependencies(folder({ '@acme/x': '1.0.0', b: 'file:/w/b' }))).toEqual({ '@acme/x': '1.0.0', b: 'file:/w/b' });
    expect(operatorDependencies(folder({}))).toEqual({});
    expect(operatorDependencies({ name: 'neuralis', dependencies: { neuralis: '0.2.0', '@acme/x': '1.0.0' } })).toBeNull();
    expect(operatorDependencies({ name: 'neuralis', dependencies: { '@neuralis/agent-core': '0.2.0' } })).toBeNull();
  });

  it('no operator package ⇒ no derived image, the helper is never read, and compose keeps the release image line', () => {
    let read = 0;
    expect(plan(folder({}), { readBuildHelper: () => { read += 1; return ''; } })).toBeNull();
    expect(read).toBe(0);
    const block = serviceBlock(buildComposeContent(baseInput({ monorepo: false, imageTag: '0.2.0', operatorImage: null }), STAMP), 'neuralis');
    expect(block).toContain('    image: neuralisapp/neuralis:0.2.0\n');
    expect(block).not.toContain('    build:\n');
  });

  it('the Dockerfile is the release image plus one operator-install layer: build tools for native deps, the .npmrc a secret', () => {
    const image = plan(folder({ '@acme/x': '1.0.0' }), {
      build: { localSources: [{ slot: 0, name: '@acme/y', contextDir: '/w/y' }], buildLockDir: '/home/op/.neuralis/build', npmrcFile: '/home/op/.npmrc' },
    })!;
    const dockerfile = image.files.Dockerfile!;
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1\n/);
    expect(dockerfile).toContain('FROM neuralisapp/neuralis:0.2.0 AS release\n');
    expect(dockerfile).toContain('FROM scratch AS localpkg0\nFROM scratch AS buildlock\nFROM release\nUSER root\n');
    expect(dockerfile).toContain('COPY --from=localpkg0 / /tmp/operator/slots/0/\n');
    expect(dockerfile).toContain('RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \\\n');
    expect(dockerfile).toContain('apk add --no-cache --virtual .operator-build python3 make g++ && \\\n');
    expect(dockerfile).toContain('node /tmp/operator/build-workspace.mjs operator-install /tmp/operator /neuralis /root/.npmrc && \\\n');
    expect(dockerfile).toContain('apk del .operator-build');
    expect(dockerfile.trimEnd().endsWith('USER nextjs')).toBe(true);
    // The operator lines verbatim — the list `pkg add` validated — and nothing from the environment.
    expect(JSON.parse(image.files['operator.json']!)).toEqual({ dependencies: { '@acme/x': '1.0.0' } });
    expect(image.files['build-workspace.mjs']).toBe('// the build helper\n');
  });

  it('the image name carries the release tag and a hash of the context: stable for one set, new for a new set or release', () => {
    const a = plan(folder({ '@acme/x': '1.0.0' }))!;
    expect(a.name).toMatch(/^neuralis-neuralis:0\.2\.0-[0-9a-f]{12}$/);
    expect(plan(folder({ '@acme/x': '1.0.0' }))!.name).toBe(a.name);
    expect(plan(folder({ '@acme/x': '1.0.1' }))!.name).not.toBe(a.name);
    expect(plan(folder({ '@acme/x': '1.0.0' }), { imageTag: '0.2.1' })!.name).toMatch(/^neuralis-neuralis:0\.2\.1-/);
  });

  it('compose builds it from the generated context with the same named contexts and secret, and runs it by that name', () => {
    const build = { localSources: [{ slot: 0, name: '@acme/y', contextDir: '/w/y' }], buildLockDir: null, npmrcFile: '/home/op/.npmrc' };
    const operatorImage = plan(folder({ '@acme/y': 'file:/w/y' }), { build })!;
    const content = buildComposeContent(baseInput({ monorepo: false, imageTag: '0.2.0', build, operatorImage }), STAMP);
    const block = serviceBlock(content, 'neuralis');
    expect(block).toContain('    build:\n      context: "/home/op/install/operator-image"\n');
    expect(block).toContain('        localpkg0: "/w/y" # @acme/y\n');
    expect(block).toContain('      secrets:\n        - npmrc\n');
    expect(block).toContain(`    image: ${operatorImage.name}\n`);
    expect(block).not.toContain('neuralisapp/neuralis:0.2.0');
    expect(content).toContain('\nsecrets:\n  npmrc:\n    file: "/home/op/.npmrc"\n');
  });

  it('the link the operator install writes is the --pkg bind target (one path formula)', () => {
    for (const name of ['@acme/x', 'plain']) expect(join('/neuralis', 'node_modules', name)).toBe(packageBindTarget(name));
  });
});

describe('resolveBuildInputs — derived from the host manifest, checked before anything is written', () => {
  function sandbox(deps: Record<string, string>, files: Record<string, string> = {}): { root: string; host: string } {
    const root = mkdtempSync(join(tmpdir(), 'neuralis-build-inputs-'));
    const host = join(root, 'repo', 'neuralis');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neuralis', dependencies: deps }));
    writeFileSync(join(root, 'repo', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return { root, host };
  }

  it('assigns slots in NAME order — the order the builder derives from the same manifest', () => {
    const { root, host } = sandbox(
      { '@zed/b': `file:${'__ROOT__'}/b`, '@acme/a': `file:${'__ROOT__'}/a`, react: '19.3.0' },
      { 'a/package.json': '{}', 'b/package.json': '{}' },
    );
    try {
      const manifest = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
      for (const k of Object.keys(manifest.dependencies)) manifest.dependencies[k] = manifest.dependencies[k].replace('__ROOT__', root);
      writeFileSync(join(host, 'package.json'), JSON.stringify(manifest));
      const inputs = resolveBuildInputs({ hostDir: host, repoRoot: join(root, 'repo'), neuralisHome: join(root, 'home'), npmrcPath: undefined });
      expect(inputs.localSources).toEqual([
        { slot: 0, name: '@acme/a', contextDir: join(root, 'a') },
        { slot: 1, name: '@zed/b', contextDir: join(root, 'b') },
      ]);
      expect(inputs.buildLockDir).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a vanished folder is named with the pnpm wording and the remove command — nothing is written', () => {
    const { root, host } = sandbox({ '@acme/gone': 'file:/nonexistent/acme-gone' });
    try {
      expect(() => resolveBuildInputs({ hostDir: host, repoRoot: join(root, 'repo'), neuralisHome: join(root, 'home'), npmrcPath: undefined }))
        .toThrow(/@acme\/gone: Could not install from "\/nonexistent\/acme-gone" as it does not exist .*pnpm neuralis:pkg remove @acme\/gone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the exported build lock is passed back only when it was resolved over the SAME tracked lock', () => {
    const { root, host } = sandbox({}, { 'a/package.json': '{}' });
    try {
      const manifest = { name: 'neuralis', dependencies: { '@acme/a': `file:${join(root, 'a')}` } };
      writeFileSync(join(host, 'package.json'), JSON.stringify(manifest));
      const home = join(root, 'home');
      mkdirSync(join(home, 'build'), { recursive: true });
      writeFileSync(join(home, 'build', 'pnpm-lock.yaml'), 'build lock');
      const tracked = readFileSync(join(root, 'repo', 'pnpm-lock.yaml'), 'utf8');
      writeFileSync(join(home, 'build', 'tracked-lock.sha256'), `${createHash('sha256').update(tracked).digest('hex')}\n`);
      const args = { hostDir: host, repoRoot: join(root, 'repo'), neuralisHome: home, npmrcPath: undefined };
      expect(resolveBuildInputs(args).buildLockDir).toBe(join(home, 'build'));
      writeFileSync(join(root, 'repo', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nmoved: true\n');
      expect(resolveBuildInputs(args).buildLockDir).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an .npmrc with a default registry= line (pnpm would fetch itself from it) and a missing one', () => {
    const { root, host } = sandbox({}, { 'npmrc-bad': 'registry=http://127.0.0.1:4873/\n', 'npmrc-ok': '@acme:registry=http://127.0.0.1:4873/\n//127.0.0.1:4873/:_authToken=t\n' });
    try {
      const base = { hostDir: host, repoRoot: join(root, 'repo'), neuralisHome: join(root, 'home') };
      expect(() => resolveBuildInputs({ ...base, npmrcPath: join(root, 'npmrc-bad') })).toThrow(/default `registry=` line/);
      expect(() => resolveBuildInputs({ ...base, npmrcPath: join(root, 'missing') })).toThrow(/no such file/);
      expect(resolveBuildInputs({ ...base, npmrcPath: join(root, 'npmrc-ok') }).npmrcFile).toBe(join(root, 'npmrc-ok'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records every private scope the .npmrc routes before the build, and hands the folder to the build while the record holds one — no local package, no .npmrc', () => {
    const { root, host } = sandbox({}, { npmrc: '@acme:registry=http://127.0.0.1:4873/\n//127.0.0.1:4873/:_authToken=t\n' });
    try {
      const base = { hostDir: host, repoRoot: join(root, 'repo'), neuralisHome: join(root, 'home') };
      expect(resolveBuildInputs({ ...base, npmrcPath: undefined }).buildLockDir).toBeNull();
      expect(resolveBuildInputs({ ...base, npmrcPath: join(root, 'npmrc') }).buildLockDir).toBe(join(root, 'home', 'build'));
      const record = JSON.parse(readFileSync(join(root, 'home', 'build', 'private-scopes.json'), 'utf8'));
      expect(record.scopes['@acme'].origins).toEqual(['http://127.0.0.1:4873']);
      // The .npmrc unset since: the scope stays recorded and the folder still rides.
      expect(resolveBuildInputs({ ...base, npmrcPath: undefined }).buildLockDir).toBe(join(root, 'home', 'build'));
      writeFileSync(join(root, 'home', 'build', 'private-scopes.json'), '{"scopes": 1}');
      expect(() => resolveBuildInputs({ ...base, npmrcPath: undefined })).toThrow(/private-scope record: .*private-scopes\.json cannot be read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('setup --compose-only in an npm install folder writes the derived image and its context (the wiring)', () => {
  const realHost = join(dirname(new URL(import.meta.url).pathname), '..', '..');

  /** Three ports nothing holds now — the regeneration's port check must find them free on any machine. */
  async function freePortLines(): Promise<string> {
    const servers = await Promise.all([0, 1, 2].map(() => new Promise<ReturnType<typeof createServer>>((ready) => { const s = createServer(); s.listen(0, '0.0.0.0', () => ready(s)); })));
    const [app, mcp, sandbox] = servers.map((s) => (s.address() as AddressInfo).port);
    await Promise.all(servers.map((s) => new Promise((closed) => s.close(closed))));
    return `NEURALIS_APP_PORT=${app}\nMCP_HTTP_PORT=${mcp}\nNEURALIS_MCP_SANDBOX_PORT=${sandbox}\n`;
  }

  async function installFolder(deps: Record<string, string>): Promise<{ folder: string; home: string; bin: string }> {
    const root = mkdtempSync(join(tmpdir(), 'neuralis-derived-'));
    const host = join(root, 'host');
    mkdirSync(host, { recursive: true });
    cpSync(join(realHost, 'scripts'), join(host, 'scripts'), { recursive: true });
    symlinkSync(join(realHost, 'node_modules'), join(host, 'node_modules'), 'dir');
    symlinkSync(join(realHost, 'src'), join(host, 'src'), 'dir');
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neuralis', version: '0.2.0', bin: { neuralis: 'bin/neuralis.mjs' } }));
    // Inside the host copy only so `--import tsx` resolves; the walk-up stops at the folder's own manifest.
    const folder = join(host, 'install');
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: '0.2.0', ...deps } }, null, 2));
    writeFileSync(join(folder, '.env'), `NEURALIS_IMAGE_TAG=0.2.0\nQDRANT_MODE=skip\nBRAIN_INFRA_MODE=inmemory\nNEURALIS_COMPOSE_PROJECT=neuralis\nNEXTAUTH_SECRET=x\n${await freePortLines()}`);
    // A CLI with its Compose plugin and no daemon: the environment probe must not reach this
    // machine's daemon, and an offline regeneration needs only the CLI and the plugin.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho \'[{"Name":"compose"}]|\'\necho \'Cannot connect to the Docker daemon\' >&2\nexit 1\n', { mode: 0o755 });
    return { folder, home: join(root, 'home'), bin };
  }

  function composeOnly(dirs: { folder: string; home: string; bin: string }) {
    return spawnSync(process.execPath, ['--import', 'tsx', join(dirs.folder, '..', 'scripts', 'cli', 'registry.mts'), 'setup', '--compose-only'], {
      cwd: dirs.folder,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dirs.bin}:${process.env.PATH ?? ''}`, NEURALIS_HOME: dirs.home, QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9' },
    });
  }

  it('operator packages ⇒ a build block over the generated context, the derived name, and the three context files', async () => {
    const dirs = await installFolder({ '@acme/x': '1.0.0' });
    const res = composeOnly(dirs);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    const block = serviceBlock(readFileSync(join(dirs.folder, 'docker-compose.yml'), 'utf8'), 'neuralis');
    expect(block).toContain(`    build:\n      context: ${JSON.stringify(join(dirs.folder, 'operator-image'))}\n`);
    expect(block).toMatch(/^ {4}image: neuralis-neuralis:0\.2\.0-[0-9a-f]{12}$/m);
    expect(readdirSync(join(dirs.folder, 'operator-image')).sort()).toEqual(['Dockerfile', 'build-workspace.mjs', 'operator.json']);
    expect(readFileSync(join(dirs.folder, 'operator-image', 'build-workspace.mjs'), 'utf8')).toBe(readFileSync(join(realHost, 'scripts', 'build', 'build-workspace.mjs'), 'utf8'));
  });

  it('control: no operator package ⇒ no context folder and the release image line, unchanged', async () => {
    const dirs = await installFolder({});
    const res = composeOnly(dirs);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    const block = serviceBlock(readFileSync(join(dirs.folder, 'docker-compose.yml'), 'utf8'), 'neuralis');
    expect(block).toContain('    image: neuralisapp/neuralis:0.2.0\n');
    expect(block).not.toContain('    build:\n');
    expect(existsSync(join(dirs.folder, 'operator-image'))).toBe(false);
  });
});

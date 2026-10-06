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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NO_BUILD_INPUTS, buildComposeContent, resolveBuildInputs, type ComposeEmitInput } from '../setup/compose.mts';
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
    ...overrides,
  };
}

/** The service block for `name:` — from its header to the next top-level-ish key. */
function serviceBlock(content: string, name: string): string {
  const start = content.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name} present`).toBeGreaterThan(-1);
  const rest = content.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n')).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + rest.indexOf('\n'));
}

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

  it('the image channel never builds: no build block, so no contexts and no secret even when inputs exist', () => {
    const content = buildComposeContent(
      baseInput({ monorepo: false, imageTag: '0.1.0', build: { localSources: sources, buildLockDir: '/x', npmrcFile: '/y' } }),
      STAMP,
    );
    expect(content).not.toContain('additional_contexts:');
    expect(content).not.toMatch(/^secrets:/m);
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

import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvContent } from '../setup/envFile.mts';
import { QDRANT_TARGET_VERSION, qdrantBinaryAsset } from '../setup/qdrantVersion.mts';
const host = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
/** The bundled derivative is tagged with the release's own version (the host package.json). */
const image = `neuralisapp/webtop-ubuntu-xfce:${(JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')) as { version: string }).version}`;
/** Ports nothing on this machine holds now: the wizard's port check must find them free wherever the suite runs. */
async function freePorts(): Promise<{ app: number; mcp: number; sandbox: number }> {
  const servers = await Promise.all([0, 1, 2].map(() => new Promise<ReturnType<typeof createServer>>((ready) => { const s = createServer(); s.listen(0, '0.0.0.0', () => ready(s)); })));
  const [app, mcp, sandbox] = servers.map((s) => (s.address() as AddressInfo).port) as [number, number, number];
  await Promise.all(servers.map((s) => new Promise((closed) => s.close(closed))));
  return { app, mcp, sandbox };
}
const portLines = (p: { app: number; mcp: number; sandbox: number }) => `NEURALIS_APP_PORT=${p.app}\nMCP_HTTP_PORT=${p.mcp}\nNEURALIS_MCP_SANDBOX_PORT=${p.sandbox}\n`;
function fixture(docker: boolean): { root: string; env: NodeJS.ProcessEnv; output: string; transcript: string } {
  const root = mkdtempSync(join('/tmp', 'neuralis-machine-setup-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'out'));
  const transcript = join(root, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(args)+'\\n');\nif (${!docker}) process.exit(1);\nif (args[0] === 'info') console.log('[{"Name":"compose"}]|29.0.0');\nif (args[0] === 'compose') console.log('[]');\n// A fresh machine: no Qdrant volume yet.\nif (args[0] === 'volume') { console.error('Error response from daemon: get x: no such volume'); process.exit(1); }\n`, { mode: 0o700 });
  const preload = join(root, 'offline.mjs');
  // Reject every service probe before network IO, including provider discovery.
  writeFileSync(preload, `import http from 'node:http';\nimport https from 'node:https';\nimport { EventEmitter } from 'node:events';\nhttp.get = https.get = () => { const req = new EventEmitter(); req.destroy = () => {}; queueMicrotask(() => req.emit('error', new Error('offline fixture'))); return req; };\nglobalThis.fetch = async () => { throw new Error('offline fixture'); };\n`);
  return { root, transcript, output: join(root, 'out'), env: { NODE_ENV: 'test', HOME: root, NEURALIS_HOME: join(root, 'data'), PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9' } };
}
async function run(f: ReturnType<typeof fixture>, args: string[], questions: [string, string][] = []): Promise<string> {
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/cli/registry.mts', 'setup', ...args, '--output', f.output], { cwd: host, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let cursor = 0; let consumed = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout at ${questions[cursor]?.[0]}:\n${output}`)); }, 20000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const clean = output.replace(/\x1b\[[0-9;]*m/g, ''); const question = questions[cursor];
      if (!question || !clean.slice(consumed).includes(question[0]) || !clean.endsWith(': ')) return;
      consumed = clean.length; cursor += 1;
      // Sensitive entries consume characters and newline as separate data chunks.
      if (/password/i.test(question[0])) { child.stdin.write(question[1]); setTimeout(() => child.stdin.write('\n'), 15); }
      else child.stdin.write(`${question[1]}\n`);
    });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer); child.stdin.end();
      if (code !== 0 || cursor !== questions.length) reject(new Error(`Exit ${code}, ${cursor}/${questions.length} answers:\n${output}`));
      else resolveRun(output);
    });
  });
}
const OWNER: [string, string][] = [
  ['Email:', 'owner@example.test'], ['Password (min 8 chars, hidden):', 'disposable-password'], ['Confirm password (hidden):', 'disposable-password'], ['Name [owner]:', 'Owner'],
];
/** `setup --advanced`: today's full question set, every one asked. */
async function advancedWizard(f: ReturnType<typeof fixture>, docker: boolean, prefetch: boolean): Promise<string> {
  // A carried .env with free ports: the run re-decides nothing the port check would ask about.
  const ports = await freePorts();
  writeFileSync(join(f.output, '.env'), portLines(ports));
  const questions: [string, string][] = [
    ...OWNER, ['Pick a deployment mode', '1'],
    ['Anthropic (Claude) API key', ''], ['Google Gemini API key:', ''], ['DeepSeek API key:', ''],
    ['Configure more providers?', 'n'], ['How do you want to connect OpenAI?', '5'],
    [docker ? 'How to run Qdrant?' : 'Qdrant is not running. Options:', '3'],
    ['Where is Ollama (your local LLM runtime) running?', '4'], ['Add a custom LLM endpoint?', 'n'],
    ...(docker ? [['Turn on the virtual desktop (machine-core)?', 'y'], ['Pre-pull the Neuralis desktop image now (background)?', prefetch ? 'y' : 'n']] as [string, string][] : []),
    ['Project name', 'Desktop fixture'], [`Public origin [http://localhost:${ports.app}]:`, ''],
    ['Publish the ChatGPT sign-in callback?', '1'], ['Trusted proxies:', ''], ['Overwrite?', 'y'],
  ];
  return run(f, ['--advanced'], questions);
}
/** The default run: the owner (password typed twice), the deployment mode of a checkout, the
 * public origin, and the Qdrant choice only where no Docker answers; everything else unasked. */
const NO_DOCKER = 'How do you want to continue?';
async function wizard(f: ReturnType<typeof fixture>, docker: boolean, owner: [string, string][] = OWNER, noDocker = '3'): Promise<{ output: string; app: number }> {
  // The Docker-stack Qdrant is the default answer: its port is a free one too.
  const ports = await freePorts();
  const qdrant = (await freePorts()).app;
  writeFileSync(join(f.output, '.env'), `${portLines(ports)}NEURALIS_QDRANT_PORT=${qdrant}\n`);
  const questions: [string, string][] = [
    ...(docker ? [] : [[NO_DOCKER, noDocker] as [string, string]]),
    ...owner, ...(docker ? [['Pick a deployment mode', '1'] as [string, string]] : []),
    [`Public origin [http://localhost:${ports.app}]:`, ''], ['Overwrite?', 'y'],
  ];
  return { output: await run(f, [], questions), app: ports.app };
}
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const UNASKED = ['Anthropic (Claude) API key', 'Google Gemini API key', 'Configure more providers?', 'How do you want to connect OpenAI?', 'How to run Qdrant?', 'Where is Ollama', 'Add a custom LLM endpoint?',
  'Which provider?', 'Turn on the virtual desktop', 'Pre-pull the Neuralis desktop image now', 'Project name', 'Publish the ChatGPT sign-in callback?', '── Reverse proxy', 'Start Neuralis now?'];
function commands(f: ReturnType<typeof fixture>): string[][] {
  return existsSync(f.transcript) ? readFileSync(f.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [];
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('bundled desktop setup through the real CLI', () => {
  it('the default run asks the owner (twice-typed password), the deployment mode and the origin; every other answer is its default; a re-run asks no owner', async () => {
    const f = fixture(true);
    // A mistyped confirmation asks for the password again.
    const owner: [string, string][] = [OWNER[0]!, OWNER[1]!, ['Confirm password (hidden):', 'disposable-passwrod'], OWNER[1]!, OWNER[2]!, OWNER[3]!];
    const output = plain((await wizard(f, true, owner)).output);
    expect(output).toContain('The passwords do not match');
    for (const literal of UNASKED) expect(output, literal).not.toContain(`${literal}`);
    const config = JSON.parse(readFileSync(join(f.root, 'data/app/config/platform.json'), 'utf8')) as Record<string, unknown>;
    // The embedding target is the recommended model, off until its key is in the app.
    expect(config.embeddingEnabled).toBe(false);
    expect(typeof config.embeddingModelId).toBe('string');
    expect(typeof config.embeddingDimension).toBe('number');
    expect(config.localLLMs).toBeUndefined();
    expect(readFileSync(join(f.output, '.env'), 'utf8')).toMatch(/^QDRANT_MODE=docker$/m);
    expect(readFileSync(join(f.output, '.env'), 'utf8')).toMatch(/^NEURALIS_CODEX_LOOPBACK=/m);
    expect(output).toContain('Project: My Workspace');
    expect(output).toContain('Next, in the app');
    expect(output).toContain('pnpm neuralis:setup --advanced');
    // The desktop image pull is the default answer: started in the background.
    await expect.poll(() => commands(f).filter((args) => args[0] === 'pull')).toEqual([['pull', image]]);
    expect(output).toMatch(/Background pull kicked off \(pid \d+\)/);
  }, 30_000);
  it('a native checkout with Docker gets the compose Qdrant by default, and its next steps start it first', async () => {
    const f = fixture(true);
    const ports = await freePorts();
    writeFileSync(join(f.output, '.env'), `${portLines(ports)}NEURALIS_QDRANT_PORT=${(await freePorts()).app}\n`);
    const output = plain(await run(f, [], [...OWNER, ['Pick a deployment mode', '2'], ['Public origin', ''], ['Overwrite?', 'y']]));
    const next = output.slice(output.lastIndexOf('Next steps:'), output.indexOf('Then open:'));
    expect(next.indexOf('docker compose up -d qdrant')).toBeGreaterThan(-1);
    expect(next.indexOf('docker compose up -d qdrant')).toBeLessThan(next.search(/neuralis[: ]start/));
    expect(next).not.toContain('npm run start'); // it binds 3100 whatever .env says
  }, 30_000);
  it('--help prints the usage and starts nothing', async () => {
    const f = fixture(true);
    const output = await run(f, ['--help']);
    expect(output).toContain('--advanced');
    expect(output).not.toContain('Owner Account');
    expect(existsSync(join(f.root, 'data'))).toBe(false);
    expect(commands(f)).toEqual([]);
  });
  it.each([true, false])('--advanced asks today\'s full set; Docker prefetch=%s keeps env, compose and platform on the exact derivative', async (prefetch) => {
    const f = fixture(true); const output = await advancedWizard(f, true, prefetch);
    const env = parseEnvContent(readFileSync(join(f.output, '.env'), 'utf8'));
    expect(env.NEURALIS_MACHINE_IMAGE).toBe(image);
    // The variant and the idle timeout are platform settings: platform.json is their one place, never a .env seed.
    expect(env).not.toHaveProperty('NEURALIS_MACHINE_DESKTOP_VARIANT'); expect(env).not.toHaveProperty('NEURALIS_MACHINE_IDLE_MINUTES');
    expect(readFileSync(join(f.output, 'docker-compose.yml'), 'utf8')).toContain(`NEURALIS_MACHINE_IMAGE=${image}`);
    const config = JSON.parse(readFileSync(join(f.root, 'data/app/config/platform.json'), 'utf8')) as Record<string, unknown>;
    expect(config.machineImage).toBe(image); expect(config.machineDesktopVariant).toBe('ubuntu-xfce');
    expect(output).not.toContain('Pick a desktop variant'); expect(output).not.toContain('KasmVNC');
    // The CLI has exited; a bounded wait observes the detached fake child's log flush.
    if (prefetch) await expect.poll(() => commands(f).filter((args) => args[0] === 'pull')).toEqual([['pull', image]]);
    else expect(commands(f).filter((args) => args[0] === 'pull')).toEqual([]);
    if (prefetch) expect(output).toContain('first desktop open may still wait');
    expect(output).not.toContain('Next, in the app');
  });
  it('without Docker ONE early question; Enter = install Docker first: the link, exit 0, nothing written', async () => {
    const f = fixture(false);
    const output = plain(await run(f, [], [[NO_DOCKER, '']]));
    expect(output).toContain('Docker is not installed or not reachable. The vector store (Qdrant) and the virtual desktop need it.');
    expect(output).toContain('[1] Install Docker first (recommended) — prints the link, writes nothing, re-run setup after');
    expect(output).toContain('https://docs.docker.com/engine/install/');
    expect(output).toContain('Nothing was written.');
    expect(output).not.toContain('Owner Account');
    expect(readdirSync(f.output)).toEqual([]);
    expect(existsSync(join(f.root, 'data'))).toBe(false);
  });
  it('without Docker, [2] continues natively: the binary download is attempted, a failure is named and in-memory follows; no Qdrant question', async () => {
    const f = fixture(false); const output = plain((await wizard(f, false, OWNER, '2')).output);
    if (qdrantBinaryAsset(QDRANT_TARGET_VERSION)) expect(output).toContain('Qdrant download failed: offline fixture');
    else expect(output).toContain(`No Qdrant binary is published for ${process.platform}/${process.arch}.`);
    expect(output).not.toContain('Qdrant is not running. Options:');
    expect(output).not.toContain('Pick a deployment mode');
    expect(readFileSync(join(f.output, '.env'), 'utf8')).toMatch(/^QDRANT_MODE=skip$/m);
  }, 30_000);
  it('a FRESH native checkout settles its app port: a held 3100 moves the .env to a free one; a re-run keeps the recorded port (paired control)', async () => {
    const f = fixture(false);
    // 3100 held for the run — by this test when free, else by whoever holds it already.
    const hold = createServer();
    await new Promise<void>((ready) => { hold.once('error', () => ready()); hold.listen(3100, '0.0.0.0', () => ready()); });
    try {
      writeFileSync(join(f.output, '.env'), `NEURALIS_QDRANT_PORT=${(await freePorts()).app}\n`);
      await run(f, [], [[NO_DOCKER, '3'], ...OWNER, ['Public origin', ''], ['Overwrite?', 'y']]);
      const first = parseEnvContent(readFileSync(join(f.output, '.env'), 'utf8'));
      expect(Number(first.NEURALIS_APP_PORT)).not.toBe(3100);
      expect(first.NEXTAUTH_URL).toContain(`:${first.NEURALIS_APP_PORT}`);
      const recorded = (await freePorts()).app;
      writeFileSync(join(f.output, '.env'), readFileSync(join(f.output, '.env'), 'utf8').replace(/^NEURALIS_APP_PORT=.*$/m, `NEURALIS_APP_PORT=${recorded}`));
      await run(f, [], [[NO_DOCKER, '3'], ['What would you like to do?', '1'], ['Project to maintain', ''], ['Public origin', ''], ['Overwrite?', 'y'], ['Overwrite?', 'y']]);
      expect(Number(parseEnvContent(readFileSync(join(f.output, '.env'), 'utf8')).NEURALIS_APP_PORT)).toBe(recorded);
    } finally {
      await new Promise((closed) => hold.close(closed));
    }
  }, 40_000);
  it('without Docker, [3] runs in-memory with no download and no Qdrant question; the runtime warning stays; a re-run keeps the users and asks no owner', async () => {
    const f = fixture(false); const { output } = await wizard(f, false, OWNER, '3');
    expect(plain(output)).not.toContain('Downloading Qdrant');
    expect(output).not.toContain('Qdrant is not running. Options:');
    expect(readFileSync(join(f.output, '.env'), 'utf8')).toMatch(/^QDRANT_MODE=skip$/m);
    const rerun = plain(await run(f, [], [[NO_DOCKER, '3'], ['What would you like to do?', '1'], ['Project to maintain', ''], ['Public origin', ''], ['Overwrite?', 'y'], ['Overwrite?', 'y']]));
    expect(rerun).not.toContain('Email:');
    expect(rerun).not.toContain('Password');
    expect(rerun).toContain('Owner: Owner <owner@example.test>');
    expect(plain(output)).toContain('Docker not available — the virtual desktop stays off'); expect(output).not.toContain('Pre-pull the Neuralis desktop image now');
    // The core-package list, and the one left off without Docker, in the home's platform config.
    expect(plain(output)).toContain('@neuralis/admin · @neuralis/agent-core · @neuralis/brain-core — always on');
    expect(JSON.parse(readFileSync(join(f.root, 'data', 'app', 'config', 'platform.json'), 'utf8'))).toMatchObject({ disabledBuiltinPackages: ['@neuralis/machine-core'] });
    expect(commands(f).filter((args) => args[0] === 'pull')).toEqual([]);
  }, 30_000);
  it('compose-only preserves an arbitrary custom image, leaves the variant to platform.json and .env, and keeps the admin config', async () => {
    const f = fixture(true);
    const configDir = join(f.root, 'data/app/config'); mkdirSync(configDir, { recursive: true });
    const admin = '{"machineImage":"private.example/admin-desktop:v7","machineDesktopVariant":"admin-special"}';
    writeFileSync(join(configDir, 'platform.json'), admin);
    writeFileSync(join(f.output, '.env'), `NEXTAUTH_SECRET=fixture-only\nNEURALIS_IMAGE_TAG=0.1.0\nQDRANT_MODE=skip\nNEURALIS_MACHINE_IMAGE=private.example/custom-desktop:v9\nNEURALIS_MACHINE_DESKTOP_VARIANT=custom-special\n${portLines(await freePorts())}`);
    await run(f, ['--compose-only']);
    const compose = readFileSync(join(f.output, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('NEURALIS_MACHINE_IMAGE=private.example/custom-desktop:v9');
    // A hand-set variant line still reaches the container through `env_file: .env`; the compose file carries no second copy.
    expect(compose).not.toContain('NEURALIS_MACHINE_DESKTOP_VARIANT');
    expect(compose).toContain('      - path: .env');
    expect(readFileSync(join(configDir, 'platform.json'), 'utf8')).toBe(admin);
  });
});

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnvContent } from '../setup/envFile.mts';
const host = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots: string[] = [];
const image = 'neuralisapp/webtop-ubuntu-xfce:dev';
function fixture(docker: boolean): { root: string; env: NodeJS.ProcessEnv; output: string; transcript: string } {
  const root = mkdtempSync(join('/tmp', 'neuralis-machine-setup-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'out'));
  const transcript = join(root, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(args)+'\\n');\nif (${!docker}) process.exit(1);\nif (args[0] === '--version') console.log('Docker version 29.0.0');\nif (args[0] === 'compose') console.log('[]');\n`, { mode: 0o700 });
  const preload = join(root, 'offline.mjs');
  // Reject every service probe before network IO, including provider discovery.
  writeFileSync(preload, `import http from 'node:http';\nimport { EventEmitter } from 'node:events';\nhttp.get = () => { const req = new EventEmitter(); req.destroy = () => {}; queueMicrotask(() => req.emit('error', new Error('offline fixture'))); return req; };\nglobalThis.fetch = async () => { throw new Error('offline fixture'); };\n`);
  return { root, transcript, output: join(root, 'out'), env: { NODE_ENV: 'test', HOME: root, NEURALIS_HOME: join(root, 'data'), PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9' } };
}
async function run(f: ReturnType<typeof fixture>, args: string[], questions: [string, string][] = []): Promise<string> {
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/setup.mts', ...args, '--output', f.output], { cwd: host, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let cursor = 0; let consumed = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timeout at ${questions[cursor]?.[0]}:\n${output}`)); }, 20000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const clean = output.replace(/\x1b\[[0-9;]*m/g, ''); const question = questions[cursor];
      if (!question || !clean.slice(consumed).includes(question[0]) || !clean.endsWith(': ')) return;
      consumed = clean.length; cursor += 1;
      // Sensitive entries consume characters and newline as separate data chunks.
      if (question[0].startsWith('Password')) { child.stdin.write(question[1]); setTimeout(() => child.stdin.write('\n'), 15); }
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
async function wizard(f: ReturnType<typeof fixture>, docker: boolean, prefetch: boolean): Promise<string> {
  const questions: [string, string][] = [
    ['Email:', 'owner@example.test'], ['Password (min 8 chars, hidden):', 'disposable-password'],
    ['Name [owner]:', 'Owner'], ['Pick a deployment mode', '1'],
    ['Anthropic (Claude) API key', ''], ['Google Gemini API key:', ''], ['DeepSeek API key:', ''],
    ['Configure more providers?', 'n'], ['How do you want to connect OpenAI?', '5'],
    [docker ? 'How to run Qdrant?' : 'Qdrant is not running. Options:', '3'],
    ['Where is Ollama (your local LLM runtime) running?', '4'], ['Add a custom LLM endpoint?', 'n'],
    ...(docker ? [['Pre-pull the Neuralis desktop image now (background)?', prefetch ? 'y' : 'n'] as [string, string]] : []),
    ['Project name', 'Desktop fixture'], ['Public origin [http://localhost:3100]:', ''],
    ['Publish the ChatGPT sign-in callback?', '1'], ['Trusted proxies:', ''],
  ];
  return run(f, [], questions);
}
function commands(f: ReturnType<typeof fixture>): string[][] {
  return existsSync(f.transcript) ? readFileSync(f.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [];
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('bundled desktop setup through the real CLI', () => {
  it.each([true, false])('Docker prefetch=%s keeps env, compose and platform on the exact derivative', async (prefetch) => {
    const f = fixture(true); const output = await wizard(f, true, prefetch);
    const env = parseEnvContent(readFileSync(join(f.output, '.env'), 'utf8'));
    expect(env.NEURALIS_MACHINE_IMAGE).toBe(image); expect(env.NEURALIS_MACHINE_DESKTOP_VARIANT).toBe('ubuntu-xfce');
    expect(readFileSync(join(f.output, 'docker-compose.yml'), 'utf8')).toContain(`NEURALIS_MACHINE_IMAGE=${image}`);
    const config = JSON.parse(readFileSync(join(f.root, 'data/app/config/platform.json'), 'utf8')) as Record<string, unknown>;
    expect(config.machineImage).toBe(image); expect(config.machineDesktopVariant).toBe('ubuntu-xfce');
    expect(output).not.toContain('Pick a desktop variant'); expect(output).not.toContain('KasmVNC');
    // The CLI has exited; a bounded wait observes the detached fake child's log flush.
    if (prefetch) await expect.poll(() => commands(f).filter((args) => args[0] === 'pull')).toEqual([['pull', image]]);
    else expect(commands(f).filter((args) => args[0] === 'pull')).toEqual([]);
    if (prefetch) expect(output).toContain('first desktop open may still wait');
  });
  it('missing Docker retains the runtime warning and skips the pull question', async () => {
    const f = fixture(false); const output = await wizard(f, false, false);
    expect(output).toContain('docker-missing'); expect(output).not.toContain('Pre-pull the Neuralis desktop image now');
    expect(commands(f).filter((args) => args[0] === 'pull')).toEqual([]);
  });
  it('compose-only preserves arbitrary custom image/variant and the separate admin config', async () => {
    const f = fixture(true);
    const configDir = join(f.root, 'data/app/config'); mkdirSync(configDir, { recursive: true });
    const admin = '{"machineImage":"private.example/admin-desktop:v7","machineDesktopVariant":"admin-special"}';
    writeFileSync(join(configDir, 'platform.json'), admin);
    writeFileSync(join(f.output, '.env'), 'NEXTAUTH_SECRET=fixture-only\nNEURALIS_IMAGE_TAG=0.1.0\nQDRANT_MODE=skip\nNEURALIS_MACHINE_IMAGE=private.example/custom-desktop:v9\nNEURALIS_MACHINE_DESKTOP_VARIANT=custom-special\n');
    await run(f, ['--compose-only']);
    const compose = readFileSync(join(f.output, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('NEURALIS_MACHINE_IMAGE=private.example/custom-desktop:v9');
    expect(compose).toContain('NEURALIS_MACHINE_DESKTOP_VARIANT=custom-special');
    expect(readFileSync(join(configDir, 'platform.json'), 'utf8')).toBe(admin);
  });
});

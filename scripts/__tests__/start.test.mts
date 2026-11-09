/**
 * `neuralis start` — a source clone's app on the port its `.env` names. The
 * spawn is a fake: pinned are the `next start` argv (the `.env` port, the
 * shell's value over it, 3100 with neither) and the refusal everywhere else.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { CliContext } from '../cli/registry.mts';
import { run, startArgs, type StartDeps } from '../start.mts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A clone root (the host package itself) with a resolvable `next`, and the given `.env` lines. */
function clone(envLines: string[] | null, manifest: object = { name: 'neuralis', bin: { neuralis: 'bin/neuralis.mjs' } }): string {
  const dir = mkdtempSync(join(tmpdir(), 'nrs-start-'));
  roots.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  const next = join(dir, 'node_modules', 'next');
  mkdirSync(join(next, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(next, 'package.json'), JSON.stringify({ name: 'next', version: '0.0.0' }));
  writeFileSync(join(next, 'dist', 'bin', 'next'), '');
  if (envLines) writeFileSync(join(dir, '.env'), `${envLines.join('\n')}\n`);
  return dir;
}

function started(dir: string, env: Record<string, string> = {}): { ctx: CliContext; deps: StartDeps; calls: Array<{ args: readonly string[]; cwd: unknown }> } {
  const calls: Array<{ args: readonly string[]; cwd: unknown }> = [];
  const deps = {
    spawn: ((_cmd: string, args: readonly string[], opts: { cwd?: unknown }) => {
      calls.push({ args, cwd: opts.cwd });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as unknown as StartDeps['spawn'],
  };
  const ctx = { packageDir: dir, installDir: dir, cwd: dir, stdout: () => {}, stderr: () => {}, env } as unknown as CliContext;
  return { ctx, deps, calls };
}

describe('neuralis start', () => {
  it('runs `next start` in the clone on the .env app port; the shell\'s value wins; 3100 when neither names one', async () => {
    const dir = clone(['NEURALIS_APP_PORT=3110', 'NEURALIS_BIND_HOST=127.0.0.1']);
    const a = started(dir);
    expect(await run([], a.ctx, a.deps)).toBe(0);
    expect(a.calls).toEqual([{ args: [join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), ...startArgs(3110)], cwd: dir }]);

    const b = started(dir, { NEURALIS_APP_PORT: '3120' });
    expect(await run([], b.ctx, b.deps)).toBe(0);
    expect(b.calls[0]!.args).toContain('3120');

    const c = started(clone(null));
    expect(await run([], c.ctx, c.deps)).toBe(0);
    expect(c.calls[0]!.args.slice(1)).toEqual(startArgs(3100));
  });

  it('refuses anything but a source clone — an npm install folder, an image-only folder — and starts nothing', async () => {
    const folder = started(clone(['NEURALIS_APP_PORT=3110'], { private: true, dependencies: { neuralis: '0.3.3' } }));
    await expect(run([], folder.ctx, folder.deps)).rejects.toThrow(/runs a source clone's app, and this is not one/);
    expect(folder.calls).toEqual([]);
    const extra = started(clone([]));
    await expect(run(['--port', '1'], extra.ctx, extra.deps)).rejects.toThrow(/takes no arguments/);
    expect(extra.calls).toEqual([]);
  });
});

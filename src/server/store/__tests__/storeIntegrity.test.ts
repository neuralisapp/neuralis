/**
 * The boot integrity check names every project/user record `list` would skip
 * silently — by its path RELATIVE to the data home, never the absolute one —
 * and states how long the scan took. Real kernel `FileStore` over a temp home.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

const home = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join: j } = require('path') as typeof import('path');
  return mkdtempSync(j(tmpdir(), 'store-integrity-'));
});

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') }),
}));

import { verifyProjectRecords } from '../ProjectStore';
import { verifyUserRecords } from '../UserStore';
import type { Logger } from '../FileStore';

function captureLogger(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const logger: Logger = {
    level: 'debug',
    debug: (msg) => lines.push({ level: 'debug', msg }),
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
    child: () => logger,
  };
  return { logger, lines };
}

const projects = join(home, 'app', 'projects');
const users = join(home, 'app', 'users');

beforeAll(async () => {
  for (const slot of ['@neuralis/host:projectStore', '@neuralis/host:userStore']) {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(slot)];
  }
  await mkdir(projects, { recursive: true });
  await mkdir(users, { recursive: true });
  await writeFile(join(projects, 'good.json'), JSON.stringify({ id: 'good' }));
  await writeFile(join(projects, 'torn.json'), '{"id":"torn"}\n}');
  await writeFile(join(projects, 'locked.json'), JSON.stringify({ id: 'locked' }));
  await chmod(join(projects, 'locked.json'), 0o000);
  await writeFile(join(users, 'u1.json'), JSON.stringify({ id: 'u1' }));
});

afterAll(async () => {
  await chmod(join(projects, 'locked.json'), 0o600).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

describe('boot store-integrity report', () => {
  it('names each damaged project record by RELATIVE path and kind, then the count and the scan time', async () => {
    const { logger, lines } = captureLogger();
    expect(await verifyProjectRecords(logger)).toBe(2);
    const errors = lines.filter((l) => l.level === 'error').map((l) => l.msg).sort();
    expect(errors).toEqual(['app/projects/locked.json unreadable', 'app/projects/torn.json unparseable']);
    const summary = lines.find((l) => l.level === 'info')?.msg ?? '';
    expect(summary).toMatch(/^app\/projects: 2 damaged record\(s\), verified in \d+ ms$/);
    for (const { msg } of lines) expect(msg).not.toContain(home);
  });

  it('a healthy store reports zero damaged records and still states its scan time', async () => {
    const { logger, lines } = captureLogger();
    expect(await verifyUserRecords(logger)).toBe(0);
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(lines.map((l) => l.msg)).toEqual([expect.stringMatching(/^app\/users: 0 damaged record\(s\), verified in \d+ ms$/)]);
  });
});

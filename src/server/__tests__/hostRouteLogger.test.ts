import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * With `routeConsoleLogLevel` empty the route log reaches `docker logs` with
 * EXACTLY the set the file gets: the console arm is gated by the file's
 * resolved `routeLogLevel`, never by the console's own level. The paired
 * control is the fast 200 at the `warn` default — a plain composite would
 * print it (console default `info`) while the file drops it. Set, the key
 * gates the console INDEPENDENTLY, in both directions.
 */

let appRoot = '';
let settings: Record<string, unknown> = {};
vi.mock('../config/env', () => ({ getEnv: () => ({ appRoot }) }));
vi.mock('../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({
    get: (key: string) => {
      if (!(key in settings)) throw new Error(`Config key not registered: "${key}"`);
      return settings[key];
    },
  }),
}));

const consoleLines: Array<{ level: string; msg: string }> = [];
vi.mock('../logging/setup', () => ({
  getLogger: () => ({
    child: () => ({
      debug: (msg: string) => consoleLines.push({ level: 'debug', msg }),
      info: (msg: string) => consoleLines.push({ level: 'info', msg }),
      warn: (msg: string) => consoleLines.push({ level: 'warn', msg }),
      error: (msg: string) => consoleLines.push({ level: 'error', msg }),
    }),
  }),
}));

/** The console form of a route line: a coloured dot before the status. */
const dotted = (msg: string, color: number) => msg.replace(/-> (\d{3})/, `-> \x1b[${color}m●\x1b[0m $1`);

async function freshModule() {
  vi.resetModules();
  return import('../logging/hostLogger');
}

function fileText(): string {
  const file = join(appRoot, 'logs', 'routes.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
}

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), 'route-log-'));
  settings = { routeLogLevel: 'warn', routeSlowMs: 1_000 };
  consoleLines.length = 0;
});

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

describe('route log sinks (file + docker console)', () => {
  it('at the warn default: a warn line reaches BOTH sinks, a fast 200 (info) reaches NEITHER', async () => {
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.info('GET health -> 200', { status: 200 });
    log.warn('GET agents -> 403 (feature)', { status: 403 });
    log.error('GET boom -> 500 (handler)', { status: 500 });

    await vi.waitFor(() => expect(fileText()).toContain('GET boom -> 500'));
    expect(fileText()).toContain('GET agents -> 403');
    expect(fileText()).not.toContain('GET health -> 200');
    expect(consoleLines).toEqual([
      { level: 'warn', msg: dotted('GET agents -> 403 (feature)', 33) },
      { level: 'error', msg: dotted('GET boom -> 500 (handler)', 31) },
    ]);
  });

  it('raising routeLogLevel to info applies LIVE to both sinks', async () => {
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.info('GET first -> 200');
    settings.routeLogLevel = 'info';
    log.info('GET second -> 200');

    await vi.waitFor(() => expect(fileText()).toContain('GET second -> 200'));
    expect(fileText()).not.toContain('GET first -> 200');
    expect(consoleLines).toEqual([{ level: 'info', msg: 'GET second -> 200' }]);
  });

  it('routeConsoleLogLevel=warn over routeLogLevel=info: the file gets the fast 200, docker logs does not', async () => {
    settings.routeLogLevel = 'info';
    settings.routeConsoleLogLevel = 'warn';
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.info('GET health -> 200', { status: 200 });
    log.warn('GET agents -> 403 (feature)', { status: 403 });

    await vi.waitFor(() => expect(fileText()).toContain('GET agents -> 403'));
    expect(fileText()).toContain('GET health -> 200');
    expect(consoleLines).toEqual([{ level: 'warn', msg: dotted('GET agents -> 403 (feature)', 33) }]);
  });

  it('a console level BELOW the file level prints the lines the file drops', async () => {
    settings.routeConsoleLogLevel = 'info';
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.info('GET health -> 200', { status: 200 });
    log.warn('GET agents -> 403 (feature)', { status: 403 });

    await vi.waitFor(() => expect(fileText()).toContain('GET agents -> 403'));
    expect(fileText()).not.toContain('GET health -> 200');
    expect(consoleLines).toEqual([
      { level: 'info', msg: dotted('GET health -> 200', 32) },
      { level: 'warn', msg: dotted('GET agents -> 403 (feature)', 33) },
    ]);
  });

  it('an empty or non-level routeConsoleLogLevel follows the file, LIVE', async () => {
    settings.routeLogLevel = 'info';
    settings.routeConsoleLogLevel = 'loud';
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.info('GET first -> 200');
    settings.routeConsoleLogLevel = '';
    log.info('GET second -> 200');
    settings.routeConsoleLogLevel = 'silent';
    log.error('GET third -> 500');

    await vi.waitFor(() => expect(fileText()).toContain('GET third -> 500'));
    expect(fileText()).toContain('GET first -> 200');
    expect(consoleLines).toEqual([
      { level: 'info', msg: 'GET first -> 200' },
      { level: 'info', msg: 'GET second -> 200' },
    ]);
  });

  it('the console line carries a coloured status dot per class; the file line stays plain — PAIRED', async () => {
    settings.routeLogLevel = 'info';
    const { getRouteLogger } = await freshModule();
    const log = getRouteLogger();
    log.warn('GET dashboard -> 200 (slow 1387 ms)', { status: 200, slow: true });
    log.info('GET moved -> 302', { status: 302 });
    log.warn('POST health -> 400 (handler)', { status: 400 });
    log.error('GET boom -> 503 (handler)', { status: 503 });
    log.info('GET no-meta -> 200');

    await vi.waitFor(() => expect(fileText()).toContain('GET no-meta -> 200'));
    expect(consoleLines.map((l) => l.msg)).toEqual([
      dotted('GET dashboard -> 200 (slow 1387 ms)', 32),
      dotted('GET moved -> 302', 36),
      dotted('POST health -> 400 (handler)', 33),
      dotted('GET boom -> 503 (handler)', 31),
      'GET no-meta -> 200',
    ]);
    expect(fileText()).toContain('GET dashboard -> 200 (slow 1387 ms)');
    expect(fileText()).not.toContain('\x1b[');
    expect(fileText()).not.toContain('●');
  });

  it('routeSlowMsSource reads the live key, and answers undefined when the store cannot', async () => {
    const { routeSlowMsSource } = await freshModule();
    expect(routeSlowMsSource()).toBe(1_000);
    settings.routeSlowMs = 50;
    expect(routeSlowMsSource()).toBe(50);
    delete settings.routeSlowMs;
    expect(routeSlowMsSource()).toBeUndefined();
  });
});

/**
 * The `:3101` server parses request bodies ONLY on the routes that read them.
 *
 * It used to mount `express.json` and `express.urlencoded` app-wide, in front of
 * every package companion. A companion that forwards a body — the machine
 * stream's upload — then received an EMPTY stream whenever the browser typed
 * the file as JSON or a form, because the parser had already consumed it. Now
 * the host builds the parsers once (with the configured limit) and hands them
 * to the mount functions that own body-reading routes; each attaches them to
 * its own routes (through the companion ports). The owning package's suites pin
 * WHICH routes; this file pins the two
 * directions on real Express:
 *   1. a route that mounts the parsers still parses JSON and a form, and still
 *      answers 413 above the limit — no route became an unbounded parse;
 *   2. a path that does not mount them receives its body as the unread stream,
 *      for a JSON-typed and a form-typed upload alike;
 * and, on the source, that the real server keeps no app-wide parser and hands
 * the parsers to the companions through their ports.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpBodyParsers, buildSafeErrorResponse } from '../startMcpServer';

const LIMIT_KB = 4;

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  const parsers = buildMcpBodyParsers(LIMIT_KB);
  app.post('/owner-route', ...parsers, (req, res) => {
    res.json({ body: req.body ?? null });
  });
  // A companion-shaped mount: a regex route with NO parser in front of it.
  app.all(/^\/companion\/(.*)$/, (req, res) => {
    const parsedAlready = (req as { body?: unknown }).body !== undefined;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.json({ parsedAlready, raw: Buffer.concat(chunks).toString('utf8') });
    });
  });
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, body } = buildSafeErrorResponse(req.path, err);
    res.status(status).json(body);
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, contentType: string, body: string) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body });

describe('a route that mounts the parsers', () => {
  it('parses a JSON body', async () => {
    const res = await post('/owner-route', 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { jsonrpc: '2.0', id: 1 } });
  });

  it('parses a form body (the OAuth token request shape)', async () => {
    const res = await post('/owner-route', 'application/x-www-form-urlencoded', 'grant_type=authorization_code&code=abc');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: { grant_type: 'authorization_code', code: 'abc' } });
  });

  it('answers 413 for a JSON body above the configured limit', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(LIMIT_KB * 1024 + 16) });
    const res = await post('/owner-route', 'application/json', big);
    expect(res.status).toBe(413);
  });

  it('answers 413 for a form body above the form parser limit', async () => {
    const big = `pad=${'x'.repeat(256 * 1024)}`;
    const res = await post('/owner-route', 'application/x-www-form-urlencoded', big);
    expect(res.status).toBe(413);
  });
});

describe('a path that does not mount them', () => {
  it.each([
    ['application/json', JSON.stringify({ file: 'contents of an uploaded .json file' })],
    ['application/x-www-form-urlencoded', 'a=1&b=2'],
    ['application/octet-stream', 'raw bytes'],
  ])('receives a %s body as the unread stream', async (contentType, payload) => {
    const res = await post('/companion/api/upload', contentType, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ parsedAlready: false, raw: payload });
  });

  it('receives a body far above the parser limit untouched', async () => {
    const payload = 'y'.repeat(LIMIT_KB * 1024 * 8);
    const res = await post('/companion/api/upload', 'application/json', payload);
    expect(res.status).toBe(200);
    expect((await res.json()).raw).toHaveLength(payload.length);
  });
});

describe('the real server wiring', () => {
  const source = readFileSync(join(__dirname, '..', 'startMcpServer.ts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('mounts no app-wide body parser', () => {
    expect(source).not.toMatch(/app\.use\(\s*express\.(json|urlencoded|raw|text)\(/);
    expect(source).not.toMatch(/app\.use\(\s*bodyParsers/);
  });

  it('hands the parsers to the companions through the ports, never app-wide', () => {
    expect(source).toMatch(/const bodyParsers = buildMcpBodyParsers\(bodyMaxKb\);/);
    expect(source).toMatch(/mountPackageCompanions\(\{[\s\S]*?ports: \{[\s\S]*?\n\s+bodyParsers,\n/);
  });
});

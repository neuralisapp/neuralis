import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopJoinLink, readInviteToken } from '../inviteToken';

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6';

describe('readInviteToken — the token comes from the URL fragment only', () => {
  it('reads #t=<token>', () => {
    expect(readInviteToken(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(readInviteToken(`t=${TOKEN}`)).toBe(TOKEN);
  });

  it('a token in the query is never read (the page passes it the hash, and a query-shaped hash is not one)', () => {
    expect(readInviteToken(new URL(`https://n.example/invite?t=${TOKEN}`).hash)).toBeNull();
  });

  it('refuses anything that is not a minted token shape', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#t=')).toBeNull();
    expect(readInviteToken('#t=short')).toBeNull();
    expect(readInviteToken(`#t=${TOKEN}x`)).toBeNull();
    expect(readInviteToken(`#t=${TOKEN.slice(0, 42)}%`)).toBeNull();
  });
});

describe('desktopJoinLink — the desktop app\'s ONE accepted join form', () => {
  // Mirrored from the desktop app's strict parser (`apps/desktop/src/hosts.ts`
  // `INVITE_TOKEN` + `parseJoinLink`'s shape); the row below fails when that
  // file's token rule changes, so the mirror cannot drift silently.
  const HOSTS_SRC = readFileSync(join(__dirname, '../../../../../apps/desktop/src/hosts.ts'), 'utf-8');
  const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

  it('the mirrored token rule is the desktop parser\'s own', () => {
    expect(HOSTS_SRC).toContain(`export const INVITE_TOKEN = ${INVITE_TOKEN.source.replace(/^/, '/')}/;`);
    expect(HOSTS_SRC).toContain("url.host !== 'join'");
  });

  it('host = the trusted origin as the ONLY query pair, the token ONLY in the fragment', () => {
    const link = desktopJoinLink('https://neuralis.acme.example', TOKEN);
    expect(link).toBe(`neuralis://join?host=https%3A%2F%2Fneuralis.acme.example#t=${TOKEN}`);
    const url = new URL(link);
    expect(url.protocol).toBe('neuralis:');
    expect(url.host).toBe('join');
    expect([...new URLSearchParams(url.search.slice(1))]).toEqual([['host', 'https://neuralis.acme.example']]);
    expect(url.search).not.toContain(TOKEN);
    const fragment = [...new URLSearchParams(url.hash.slice(1))];
    expect(fragment).toEqual([['t', TOKEN]]);
    expect(INVITE_TOKEN.test(fragment[0]![1])).toBe(true);
  });
});

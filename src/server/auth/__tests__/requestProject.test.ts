/**
 * O-2 / B6 — the project a host admin request acts on comes from the
 * `X-Project-Id` HEADER, the transport the admin client actually uses. There is
 * no "my first project" fallback left anywhere.
 */

import { describe, expect, it } from 'vitest';
import { resolveRequestProjectId } from '../requestProject';

function req(header?: string | null): Request {
  const headers = new Headers();
  if (header) headers.set('X-Project-Id', header);
  return new Request('http://localhost/api/admin/anything', { headers });
}

describe('resolveRequestProjectId', () => {
  it('header only ⇒ the header', () => {
    expect(resolveRequestProjectId(req('proj-1'))).toEqual({ ok: true, projectId: 'proj-1' });
  });

  it('supplied only ⇒ the supplied value', () => {
    expect(resolveRequestProjectId(req(null), 'proj-2')).toEqual({ ok: true, projectId: 'proj-2' });
  });

  it('both, agreeing ⇒ that value', () => {
    expect(resolveRequestProjectId(req('proj-3'), 'proj-3')).toEqual({ ok: true, projectId: 'proj-3' });
  });

  it('both, DISAGREEING ⇒ 403 — never authorize against one and act on the other', () => {
    const r = resolveRequestProjectId(req('proj-A'), 'proj-B');
    expect(r).toEqual({ ok: false, status: 403, error: expect.stringContaining('does not match') });
  });

  it('neither ⇒ 400, never a silent fallback (this IS O-2)', () => {
    const r = resolveRequestProjectId(req(null));
    expect(r).toEqual({ ok: false, status: 400, error: expect.stringContaining('Missing projectId') });
  });

  it('treats blank/whitespace values as absent on both sides', () => {
    expect(resolveRequestProjectId(req('   '))).toMatchObject({ ok: false, status: 400 });
    expect(resolveRequestProjectId(req(null), '  ')).toMatchObject({ ok: false, status: 400 });
    // A padded header still agrees with an unpadded body value.
    expect(resolveRequestProjectId(req(' proj-1 '), 'proj-1')).toEqual({ ok: true, projectId: 'proj-1' });
  });

  it('is case-insensitive on the header name (Headers normalizes it)', () => {
    const headers = new Headers({ 'x-project-id': 'proj-9' });
    const r = resolveRequestProjectId(new Request('http://localhost/x', { headers }));
    expect(r).toEqual({ ok: true, projectId: 'proj-9' });
  });
});

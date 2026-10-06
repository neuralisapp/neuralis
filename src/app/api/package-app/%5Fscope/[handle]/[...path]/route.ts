/**
 * GET /api/package-app/_scope/:handle/{surface|shared}/*path
 *
 * Identity-free virtual package asset GET (CARD1 3A). The `%5Fscope` folder
 * name is the documented Next.js escape for a URL segment that STARTS WITH an
 * underscore (a bare `_scope` folder would be a private, non-routing folder).
 *
 * All logic lives in `@/server/packages/packageAppAssetGet` — a `%` in an
 * import specifier is an ESM-resolution hazard, so tests import the handler
 * module directly and this file stays a thin adapter.
 */

import { NextRequest } from 'next/server';
import { handlePackageAppAssetGet } from '@/server/packages/packageAppAssetGet';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string; path: string[] }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { handle, path } = await params;
  return handlePackageAppAssetGet(req, handle, path);
}

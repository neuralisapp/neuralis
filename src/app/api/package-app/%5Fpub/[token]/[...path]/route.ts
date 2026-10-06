/**
 * GET /api/package-app/_pub/:token/{surface|shared}/*path
 *
 * The SESSION-FREE package subresource lane. The `%5Fpub` folder name is the
 * documented Next.js escape for a URL segment that STARTS WITH an underscore (a
 * bare `_pub` folder would be a private, non-routing folder) — the same escape
 * the sibling `%5Fscope` entry lane uses. The `[token]` param name may differ
 * from `%5Fscope`'s `[handle]` because their parents are distinct STATIC
 * segments; do NOT rename either for "consistency" (that would be a wire change
 * on the landed lane).
 *
 * All logic lives in `@/server/packages/packageAppPubGet` — a `%` in an import
 * specifier is an ESM-resolution hazard, so tests import the handler module
 * directly and this file stays a thin adapter.
 */

import { NextRequest } from 'next/server';
import { handlePackageAppPubGet } from '@/server/packages/packageAppPubGet';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string; path: string[] }> };

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { token, path } = await params;
  return handlePackageAppPubGet(req, token, path);
}

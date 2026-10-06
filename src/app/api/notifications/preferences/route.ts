/**
 * GET/PUT /api/notifications/preferences — the caller's notification settings
 * in the `X-Project-Id` project.
 *
 * GET answers `{ catalog, prefs }`: `catalog` is every declared event type the
 * caller COULD receive here — its package visible to them and its
 * `requires.features` held — with its title, tone, default and dock; types
 * outside it are not named at all. `prefs` is `{ mute, follow }`.
 *
 * PUT `{ mute: string[], follow: string[] }` replaces the settings. A type
 * outside the caller's catalog is dropped, so following can never reach an
 * event the caller may not see (the materializer re-judges every event per
 * recipient anyway). Answers what was stored.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { meetsRequires } from '@neuralis/package-system/access';
import type { SessionContext } from '@neuralis/package-system/contracts';
import { getRuntime } from '@/server/host/bootstrap';
import type { ProjectRecord } from '@/server/store/projectTypes';
import { readNotificationPrefs, writeNotificationPrefs } from '@/server/notifications/notificationPrefs';
import { isEventPackageVisible } from '@/server/notifications/materializer';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';

export const dynamic = 'force-dynamic';

type CatalogEntry = {
  type: string;
  packageId: string;
  title: string;
  description?: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  defaultOn: boolean;
  dock?: string;
};

async function catalogFor(session: SessionContext, project: ProjectRecord): Promise<CatalogEntry[]> {
  const events = (await getRuntime()).events();
  const out: CatalogEntry[] = [];
  for (const { type, packageId, declaration } of events.declarations()) {
    if (!isEventPackageVisible(packageId, session, project)) continue;
    if (!meetsRequires(session, declaration.requires)) continue;
    out.push({
      type,
      packageId,
      title: declaration.title,
      ...(declaration.description ? { description: declaration.description } : {}),
      tone: declaration.notify?.tone ?? 'info',
      defaultOn: declaration.notify?.default === 'on',
      ...(declaration.dock ? { dock: declaration.dock } : {}),
    });
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { session, project } = caller.member;
  const [catalog, prefs] = await Promise.all([
    catalogFor(session, project),
    readNotificationPrefs(session.projectId, session.userId),
  ]);
  return NextResponse.json({ catalog, prefs });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be { mute: string[], follow: string[] }' }, { status: 400 });
  }
  const { mute, follow } = body as { mute?: unknown; follow?: unknown };
  if (!Array.isArray(mute) || !Array.isArray(follow)) {
    return NextResponse.json({ error: 'Body must be { mute: string[], follow: string[] }' }, { status: 400 });
  }
  const { session, project } = caller.member;
  const allowed = new Set((await catalogFor(session, project)).map((entry) => entry.type));
  const keep = (list: unknown[]): string[] =>
    list.filter((type): type is string => typeof type === 'string' && allowed.has(type));
  const prefs = await writeNotificationPrefs(session.projectId, session.userId, {
    mute: keep(mute),
    follow: keep(follow),
  });
  return NextResponse.json({ prefs });
}

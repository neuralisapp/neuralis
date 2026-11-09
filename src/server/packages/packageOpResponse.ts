/**
 * The cookie doors' answer for a refused or failed project-package operation
 * (`rescanProjectPackages.ts`): the floor's 403, a refusal's own status and
 * message, and a fixed 500 for anything else (the detail stays in the log).
 */

import { NextResponse } from 'next/server';
import { getLogger } from '../logging/setup';
import { PackageManageForbiddenError, PackageOpRefusal } from './rescanProjectPackages';

export function packageOpResponse(err: unknown, failMessage: string): NextResponse {
  if (err instanceof PackageManageForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof PackageOpRefusal) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  getLogger().child('package-ops').error(failMessage, { error: err instanceof Error ? err.message : String(err) });
  return NextResponse.json({ ok: false, error: failMessage }, { status: 500 });
}

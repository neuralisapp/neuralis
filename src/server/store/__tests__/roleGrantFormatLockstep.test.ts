/**
 * The role-grant version and the `neuralis/project` data format move together.
 *
 * Nothing raises role grants at runtime: a record is seeded at the current
 * `roleGrantVersion` and a later role-grant change ships as an OFFLINE upgrade
 * module that raises `neuralis/project` in the same change. Without the paired
 * format raise, an OLDER build meeting such a record would still boot and serve
 * it with feature ids it may not know; with it, the older build refuses to boot
 * (`DataFormatNewerError`, naming the kind and the checkpoint the upgrade took).
 *
 * This pins the CURRENT pair. Raising either half alone turns it red; the fix
 * is to raise the other half and move the pair here in the same change. The
 * role-grant version is read through the exported read normalizer (an unseeded
 * record is seeded at it) because the constant itself is module-private.
 */

import { describe, expect, it } from 'vitest';
import { migrateProjectRecord } from '../ProjectStore';
import { HOST_DATA_FORMATS } from '../dataFormats';

const PINNED = { roleGrantVersion: 19, projectFormatVersion: 2 } as const;

function currentRoleGrantVersion(): number {
  const seeded = migrateProjectRecord({
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: {},
    roles: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  return seeded.roleGrantVersion ?? Number.NaN;
}

describe('role-grant version ↔ neuralis/project data format', () => {
  it('moves in lockstep: a role-grant raise also raises the project data format', () => {
    expect({
      roleGrantVersion: currentRoleGrantVersion(),
      projectFormatVersion: HOST_DATA_FORMATS.project.version,
    }).toEqual(PINNED);
  });
});

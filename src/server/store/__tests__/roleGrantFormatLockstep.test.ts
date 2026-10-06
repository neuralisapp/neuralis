/**
 * The role-grant version and the `neuralis/project` data format move together.
 *
 * Raising the role grants migrates every project record on read and stamps the
 * new `roleGrantVersion`. Without a matching data-format raise, an OLDER build
 * meeting that record still boots and serves the project read-only, with
 * feature ids it may not know — and the newer build took no pre-upgrade
 * checkpoint, because the ledger never moved. So every role-grant raise ALSO
 * raises `HOST_DATA_FORMATS.project.version`: the newer build then checkpoints
 * the project files before migrating them, and an older build refuses to boot
 * (`DataFormatNewerError`, naming the kind and the checkpoint command) instead
 * of serving the record. The pre-upgrade checkpoint is the way back.
 *
 * This pins the CURRENT pair. Raising either half alone turns it red; the fix
 * is to raise the other half and move the pair here in the same change.
 * The role-grant version is read through the exported migration because the
 * constant itself is module-private.
 */

import { describe, expect, it } from 'vitest';
import { migrateProjectRecord } from '../ProjectStore';
import { HOST_DATA_FORMATS } from '../dataFormats';

const PINNED = { roleGrantVersion: 19, projectFormatVersion: 1 } as const;

function currentRoleGrantVersion(): number {
  const migrated = migrateProjectRecord({
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: {},
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
    },
    agentOwnership: {},
    limits: { daily: {} },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    roleGrantVersion: 1,
  });
  return migrated.roleGrantVersion ?? Number.NaN;
}

describe('role-grant version ↔ neuralis/project data format', () => {
  it('moves in lockstep: a role-grant raise also raises the project data format', () => {
    expect({
      roleGrantVersion: currentRoleGrantVersion(),
      projectFormatVersion: HOST_DATA_FORMATS.project.version,
    }).toEqual(PINNED);
  });
});

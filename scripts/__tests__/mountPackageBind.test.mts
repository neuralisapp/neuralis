import assert from 'node:assert/strict';
// `describe`/`it` come from VITEST, not `node:test` (see rebuild.test.mts).
import { describe, it } from 'vitest';
import {
  insertVolumeLines,
  packageBindHostPath,
  packageBindLines,
  removePackageBind,
} from '../mount/packageBind.mts';

/**
 * The `--pkg` dev mount: a folder bound onto `/neuralis/node_modules/<name>`
 * with its own `node_modules/` masked. Pure text in, text out: these tests
 * never open the real override.
 */

const SKELETON =
  `services:\n` +
  `  neuralis:\n` +
  `    volumes:\n` +
  `      # neuralis-mount-marker: \`neuralis mount add\` inserts bind mounts below.\n` +
  `      # neuralis-overlay-marker: live host source overlay\n` +
  `      - /home/op/company:/mounts/company\n` +
  `      - /home/op/web/cli:/mounts/webcli\n` +
  `      - /home/op/neuralis:/neuralis\n` +
  `      - /neuralis/_runtime\n` +
  `      - /neuralis/node_modules\n` +
  `    environment:\n` +
  `      # neuralis-env-mount-marker: appends NEURALIS_MOUNT_* below.\n` +
  `      - NEURALIS_MOUNT_company=/mounts/company\n` +
  `      - NEURALIS_MOUNT_HOST_COMPANY=/home/op/company\n`;

describe('package bind lines', () => {
  it('binds the folder onto node_modules/<name> and masks its own node_modules', () => {
    assert.deepEqual(packageBindLines('/home/op/my pkg', '@acme/widgets'), [
      '      - /home/op/my pkg:/neuralis/node_modules/@acme/widgets',
      '      - /neuralis/node_modules/@acme/widgets/node_modules',
    ]);
  });

  it('insert lands right under the mount marker block; remove takes both lines and nothing else', () => {
    const added = insertVolumeLines(SKELETON, packageBindLines('/home/op/x', '@acme/x'));
    assert.ok(added);
    assert.equal(packageBindHostPath(added!, '@acme/x'), '/home/op/x');
    assert.equal(removePackageBind(added!, '@acme/x'), SKELETON);
    assert.equal(insertVolumeLines('services: {}\n', ['      - a:b']), null);
  });
});

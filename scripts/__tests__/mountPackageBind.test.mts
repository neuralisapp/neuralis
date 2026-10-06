import assert from 'node:assert/strict';
// `describe`/`it` come from VITEST, not `node:test` (see rebuild.test.mts).
import { describe, it } from 'vitest';
import {
  insertVolumeLines,
  migrateLegacyPackageLinks,
  packageBindHostPath,
  packageBindLines,
  removePackageBind,
} from '../mount/packageBind.mts';

/**
 * The `--pkg` dev mount: a folder bound onto `/neuralis/node_modules/<name>`
 * with its own `node_modules/` masked — and the migration of an override
 * written in the older `NEURALIS_PKG_LINKS` + `NODE_PATH` form. Pure text in,
 * text out: these tests never open the real override.
 */

const SKELETON =
  `services:\n` +
  `  neuralis:\n` +
  `    volumes:\n` +
  `      # neuralis-mount-marker: \`pnpm neuralis:mount add\` inserts bind mounts below.\n` +
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

/** The shape the live override carried before the package bind existed. */
const LEGACY =
  SKELETON +
  `      - NEURALIS_PKG_LINKS=webcli-pkg:/mounts/webcli,@acme/company:/mounts/company,@acme/ghost:/mounts/ghost\n` +
  `      - NODE_PATH=/neuralis/node_modules\n`;

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

describe('migrating a NEURALIS_PKG_LINKS override (any mount command, `list` included)', () => {
  const { content, migrated, dropped } = migrateLegacyPackageLinks(LEGACY);

  it('every link whose container path is a bind becomes a package bind of the SAME host folder', () => {
    assert.deepEqual(migrated, ['webcli-pkg', '@acme/company']);
    assert.equal(packageBindHostPath(content, '@acme/company'), '/home/op/company');
    assert.equal(packageBindHostPath(content, 'webcli-pkg'), '/home/op/web/cli');
    assert.ok(content.includes('      - /neuralis/node_modules/@acme/company/node_modules\n'));
  });

  it('removes the links line and the NODE_PATH fallback — no second discovery path survives', () => {
    assert.ok(!content.includes('NEURALIS_PKG_LINKS'));
    assert.ok(!content.includes('NODE_PATH'));
  });

  it('keeps the /mounts/<slug> data binds and their host pair (an attached source rooted there still resolves)', () => {
    assert.ok(content.includes('      - /home/op/company:/mounts/company\n'));
    assert.ok(content.includes('      - NEURALIS_MOUNT_HOST_COMPANY=/home/op/company\n'));
  });

  it('a link with no bind to take its folder from is dropped and named, never guessed', () => {
    assert.deepEqual(dropped, ['@acme/ghost:/mounts/ghost']);
  });

  it('is idempotent: a migrated override migrates to itself', () => {
    const again = migrateLegacyPackageLinks(content);
    assert.equal(again.content, content);
    assert.deepEqual(again.migrated, []);
  });

  it('control: an override with no links is returned unchanged (a stray NODE_PATH line still goes)', () => {
    assert.equal(migrateLegacyPackageLinks(SKELETON).content, SKELETON);
    assert.equal(
      migrateLegacyPackageLinks(`${SKELETON}      - NODE_PATH=/neuralis/node_modules\n`).content,
      SKELETON,
    );
  });

  it('removing a line never touches the indentation of the line after it', () => {
    const tail = `      - NEURALIS_MOUNT_after=/mounts/after\n`;
    const out = migrateLegacyPackageLinks(`${LEGACY}${tail}`).content;
    assert.ok(out.endsWith(tail), out);
    const stray = migrateLegacyPackageLinks(`${SKELETON}      - NODE_PATH=/neuralis/node_modules\n${tail}`).content;
    assert.equal(stray, `${SKELETON}${tail}`);
  });
});

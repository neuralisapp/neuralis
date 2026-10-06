#!/usr/bin/env node
/**
 * prepack guard: refuse to pack/publish the host while a machine-local
 * (file:/link:) dep line exists — the tarball embeds package.json as-is, so a
 * machine-absolute dev path (written by `pnpm neuralis:pkg add --path`) would
 * ship in the artifact. Canonical rule: build-workspace.mjs (the local-source
 * rule: built into THIS machine's image, never into a public artifact — a pack
 * is one, so it refuses).
 *
 * NEURALIS_PACK_AUDIT=1 bypasses the refusal — set ONLY by the packlist audit
 * test, which needs the real byte content on a dev machine. Publishes run from
 * a clean CI checkout and never set it. Silent on success (npm --json output
 * must stay parseable).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8'));
const offenders = Object.entries(manifest.dependencies ?? {}).filter(
  ([, spec]) => typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:')),
);

if (offenders.length > 0 && process.env.NEURALIS_PACK_AUDIT !== '1') {
  console.error('[assert-no-machine-local-deps] refusing to pack: machine-local dep line(s) present:');
  for (const [name, spec] of offenders) console.error(`  ${name}: ${spec}`);
  console.error('Remove them first (pnpm neuralis:pkg remove <name>) — publishes run from a clean checkout.');
  process.exit(1);
}

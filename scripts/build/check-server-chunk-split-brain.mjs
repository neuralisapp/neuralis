#!/usr/bin/env node
/**
 * check-server-chunk-split-brain.mjs — post-`next build` guard.
 *
 * Two checks over the same scan, in escalating order of strength:
 *
 *   1. A bundled copy of a module WITHOUT its `globalThis` anchor fails. The
 *      guard pairs a file-identifying SENTINEL literal with the ANCHOR key from
 *      the SAME source module — both must be runtime-kept strings from ONE
 *      module, since a cross-module pair could land in different chunks and
 *      false-pass. This is the defence that made split module state survivable.
 *   2. ANY bundled copy at all fails. Zero is the contract now, not an
 *      aspiration — see the long note above that check for why, and for the two
 *      filesystem halves that deliver it.
 *
 * Check 1 is deliberately kept under check 2 rather than deleted by it: per-route
 * chunking and instrumentation are still separate eval contexts, so the anchoring
 * rule has not retired, and this is the only thing that would catch it silently
 * regressing if the merge ever stops running.
 */

import { readdirSync, readFileSync, statSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// scripts/build/ → scripts/ → the host root. This file lives two levels under
// the folder it measures; a move changes this line and nothing else.
const appRoot = join(here, '..', '..');

// Stateless boot modules have no singleton anchor: measure their bundled
// presence separately, and require zero in real-directory production trees.
const ZERO_COPY_MODULES = [{
  module: 'packages/agent-core/packages/AgentCoreBootstrap.ts',
  sentinel: 'Bootstrapping agent-core',
}];

// Sentinel and anchor MUST live in the same source module (see header).
const PAIRS = [
  {
    module: 'packages/agent-core/providers/openai-codex/client.ts',
    sentinel: 'OpenAI Codex not connected — run Sign in with ChatGPT first',
    anchor: '@neuralis/agent-core:codexClient',
  },
  {
    module: 'packages/agent-core/config.ts',
    sentinel: '__neuralis_agent_core_providerSettingsCache__',
    anchor: '@neuralis/agent-core:apiKeyCache',
  },
  {
    module: 'packages/agent-core/hooks/resolvePackageHooks.ts',
    sentinel: '[hooks] Callback not found',
    anchor: '@neuralis/agent-core:firstPartyHookResolver',
  },
  {
    module: 'packages/agent-core/src/shell/ShellProcessRegistry.ts',
    // DEGENERATE PAIR, deliberately: sentinel === anchor. Read the reason
    // before "fixing" it.
    //
    // Only two of this module's exports are reachable from the bundled subgraph
    // (`hasLiveShellForScratchKey`, `sweepOrphanScratch`), so Turbopack shakes
    // out every other string it contains — measured: `shellBackgroundRingBytes`,
    // `shellExitedGcTtlMinutes`, `nrs-sh-` and the previous sentinel
    // `SHELL_REGISTRY_NOT_FOUND` all read ZERO in the .js chunks while the
    // module sits in 7 of them. That previous sentinel was a const whose only
    // consumer is a re-export nothing in the subgraph imports, so this row
    // reported "0 bundled copies" and could never have detected a reverted
    // anchor — a guard row that measured nothing.
    //
    // The `Symbol.for(...)` argument is the one literal that survives, because
    // the anchor is what the surviving code actually evaluates. Pairing it with
    // itself makes the unanchored-copy check unreachable FOR THIS ROW — say so
    // rather than let a reader assume it is live — but keeps the row honest for
    // the property that now matters: the bundled COUNT, which must be zero.
    sentinel: '@neuralis/agent-core:shellProcesses',
    anchor: '@neuralis/agent-core:shellProcesses',
  },
];

function collectChunkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (entry.endsWith('.js')) out.push(full);
    }
  }
  return out;
}

/**
 * Is this tree a pnpm workspace checkout — i.e. are the `@neuralis/*` packages
 * symlinks into a source tree rather than installed directories?
 *
 * Read from the filesystem, never from an env flag: this is the same realpath
 * property the bundler itself evaluates, so asking the disk cannot disagree with
 * what the build actually did.
 */
function neuralisScopeIsSymlinked(root) {
  const scopeDir = join(root, 'node_modules', '@neuralis');
  if (!existsSync(scopeDir)) return false;
  for (const entry of readdirSync(scopeDir)) {
    if (lstatSync(join(scopeDir, entry)).isSymbolicLink()) return true;
  }
  return false;
}

// The scan root defaults to this checkout's `.next`, but MUST be overridable:
// run inside the container and `appRoot/.next` is the HOST-OVERLAID build (the
// `--neuralis` bind mount), not the image-built `_runtime/.next` — measuring the
// wrong, older artifact while looking exactly like a real check. Pass an
// explicit root to verify a running image:
//   node check-server-chunk-split-brain.mjs /neuralis/_runtime
const rootArg = process.argv[2];
const scanBase = rootArg ? resolve(rootArg) : appRoot;
const roots = [
  join(scanBase, '.next', 'server'),
  join(scanBase, '.next', 'standalone', '.next', 'server'),
];
const files = roots.flatMap(collectChunkFiles);

if (files.length === 0) {
  console.error('[split-brain guard] no server chunk output found under .next — run after `next build`');
  process.exit(1);
}

let violations = 0;
const copyCounts = new Map([...PAIRS, ...ZERO_COPY_MODULES].map((p) => [p.module, 0]));

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  for (const module of ZERO_COPY_MODULES) {
    if (content.includes(module.sentinel)) {
      copyCounts.set(module.module, (copyCounts.get(module.module) ?? 0) + 1);
    }
  }
  for (const pair of PAIRS) {
    if (!content.includes(pair.sentinel)) continue;
    copyCounts.set(pair.module, (copyCounts.get(pair.module) ?? 0) + 1);
    if (!content.includes(pair.anchor)) {
      violations += 1;
      console.error(
        `[split-brain guard] VIOLATION: ${relative(appRoot, file)} contains a bundled copy of ` +
          `${pair.module} WITHOUT its globalThis anchor '${pair.anchor}' — ` +
          `bootstrap-wired state in that copy will silently split from the dist instance.`,
      );
    }
  }
}

for (const [module, count] of copyCounts) {
  console.log(`[split-brain guard] ${module}: ${count} bundled cop${count === 1 ? 'y' : 'ies'} in server chunks`);
}

if (violations > 0) {
  console.error(`[split-brain guard] FAILED — ${violations} unanchored bundled cop${violations === 1 ? 'y' : 'ies'}.`);
  process.exit(1);
}

// ── Zero bundled copies is now the CONTRACT, not an aspiration ──────────────
//
// `@neuralis/*` used to be compiled INTO the server chunks despite
// `serverExternalPackages` listing all six: Next externalizes only a module
// whose resolved realpath is a real path inside `node_modules` AND ends in a JS
// extension, and pnpm made every one of them a workspace SYMLINK — gate 1
// failed for the whole scope. Measured then: 6 computed externals, ZERO emitted
// aliases (vs 9-of-9 third-party), agent-core living in 7 bundled copies plus
// the dist copy the loader dynamic-imports. Eight instances of one module.
//
// The image build fixes it by compiling against the `pnpm deploy` tree, where
// every package ROOT is a real directory — the shape every registry install
// already has. The host imports no package `app/` source (every package UI is a
// prebuilt runtime module), so the whole scope can stay external.
//
// Result: 0 bundled copies on every row, agent-core and package-system emitting
// real aliases. ONE module instance, so the whole split-brain class is gone by
// construction rather than by anchoring.
//
// …but ONLY where zero is ACHIEVABLE, and that is a property of the tree, not of
// the code. In a pnpm dev workspace every `@neuralis/*` is a SYMLINK, so gate 1
// fails by construction and bundling cannot be avoided at all — `next build` from
// a workspace checkout is a legitimate thing to do (a native non-Docker deploy
// starts exactly that way) and must not be failed for a condition no edit can
// satisfy. The distinction is derived from the tree rather than configured,
// because a flag would be set wrong exactly when it matters. Where the packages
// are REAL directories — the image builder on its deploy tree, and every
// registry install — zero is both achievable and required.
const workspaceLinked = neuralisScopeIsSymlinked(appRoot);
// `SPLIT_BRAIN_ALLOW_BUNDLED=1` opts out — for comparing against a pre-fix build
// only. Never in the image build.
const allowBundled = process.env.SPLIT_BRAIN_ALLOW_BUNDLED === '1';
const bundled = [...copyCounts].filter(([, count]) => count > 0);
if (bundled.length > 0 && workspaceLinked) {
  console.log(
    '[split-brain guard] workspace checkout (@neuralis/* are symlinks) — bundled copies are ' +
      'structural here and NOT a failure. The zero-copy contract is enforced against a ' +
      'real-directory tree: the image build, and any registry install.',
  );
} else if (bundled.length > 0 && !allowBundled) {
  for (const [module, count] of bundled) {
    console.error(
      `[split-brain guard] FAILED: ${module} is BUNDLED into ${count} server chunk` +
        `${count === 1 ? '' : 's'} — it must resolve to node_modules instead. ` +
        'Check that `next build` ran on the deploy tree (neuralis/Dockerfile app-builder) ' +
        'and that the package root is a REAL directory.',
    );
  }
  process.exit(1);
}

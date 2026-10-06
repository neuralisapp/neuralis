import type { NextConfig } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeNeuralisExternalPackages,
  makeHostDepManifestReader,
} from './src/server/config/serverExternalPackages';
import { buildSecurityHeaders } from './src/server/config/securityHeaders';

// Computed config (flamingo v2 D-D — NOT code generation): every dependency
// whose package.json carries a `neuralis` block is a builtin-class package
// and must stay external to the server bundle. referenceOnly packages are
// deliberately INCLUDED (package-system is reference-only but its contracts
// are imported server-side everywhere). Unreadable manifest = build failure.
// Local-source (file:/link:) deps stay ON the externals list — they load
// in-process like every builtin, so the ONE-module-instance rule applies to
// them too; the build installs them into node_modules like any package.
const hostPackageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
};
const hostDependencies = hostPackageJson.dependencies ?? {};
const neuralisExternalPackages = computeNeuralisExternalPackages(
  Object.keys(hostDependencies),
  makeHostDepManifestReader(__dirname, { readFileSync }, join),
);

const nextConfig: NextConfig = {
  output: 'standalone',
  // `next dev` otherwise writes AGENTS.md + CLAUDE.md into this folder when it
  // detects a coding agent — a second, unowned instruction source inside the
  // public `neuralis/` tree.
  agentRules: false,
  // The Next.js standalone tracer's default workspace-root inference
  // (walks up to /neuralis where pnpm-workspace.yaml lives) is the only
  // shape that resolves the pnpm-workspace symlink graph correctly for
  // both Turbopack (build) and the Next.js runtime (server.js). Build output:
  //   /neuralis/neuralis/.next/standalone/{neuralis/{server.js, …}, node_modules/, …}
  // The runner Dockerfile flattens this AT COPY TIME (wave6.5.A) by
  // copying `.next/standalone/neuralis/.` straight into the runner WORKDIR,
  // and wave6.6 further nests the result under `/neuralis/_runtime/` so a
  // whole-folder `--neuralis` overlay can bind the host neuralis/ folder
  // onto `/neuralis` while the image-built server.js + .next + public
  // survive via an anonymous volume on /neuralis/_runtime/. The @neuralis/*
  // tarballs stay at /neuralis/node_modules/ (own anon vol) so skill/tooling
  // paths don't grow an extra segment.
  // Pinning `outputFileTracingRoot: __dirname` here breaks Turbopack root
  // inference — it cannot find `next/package.json` from `src/app/` once the
  // search is clamped to the host folder, so the flatten happens in the
  // Dockerfile, not via Next config.
  transpilePackages: [],
  serverExternalPackages: [
    // Hand-written host externals (native/server-only 3rd-party deps)…
    'bcryptjs', 'express', 'cors', 'node-pty', 'ws',
    // The terminal's server-side emulator mirror. External is REQUIRED, not a
    // preference: `@xterm/headless@6` declares `"module": "lib/xterm.mjs"`, a
    // file that does not exist in the published tarball (the real ESM build is
    // `lib-headless/xterm-headless.mjs`), and it ships no `exports` map — so a
    // bundler that honours `module` resolves to nothing. Node's own resolver
    // falls back to `main`, which is why `require`/`import()` at runtime works.
    '@xterm/headless', '@xterm/addon-serialize',
    '@modelcontextprotocol/sdk', 'esbuild', '@extism/extism',
    'dockerode', 'playwright-core',
    // …plus the computed builtin-class list (see above).
    ...neuralisExternalPackages,
  ],
  // Defense-in-depth: a workspace build resolves `@neuralis/*` through
  // pnpm-workspace
  // symlinks. The tracer occasionally pulls in source-side siblings of a
  // resolved dist file. The exclude list keeps them out of the standalone
  // tree; the runner only ever COPYs from /tmp/node_modules.tar where each
  // @neuralis/* is a tarball-extracted real directory. Standalone npm/public
  // installs have no sibling workspace; those outside-root globs must not run.
  outputFileTracingExcludes: existsSync(join(__dirname, '..', 'pnpm-workspace.yaml')) ? {
    '*': [
      '../packages/*/src/**',
      '../packages/*/test/**',
      '../packages/*/__tests__/**',
      '../packages/*/index.ts',
      '../packages/*/tsconfig.json',
      '../packages/*/tsconfig.*.json',
      '../packages/*/vitest.config.*',
      '../packages/*/.eslintrc*',
      '../packages/*/node_modules/**',
    ],
  } : undefined,
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  // The security-header rule set (incl. the CARD1 3B `/api/package-app/*`
  // path-scoped override) lives in `./src/server/config/securityHeaders.ts` so
  // it is a pure, unit-testable value; the ordering there is load-bearing.
  async headers() {
    return buildSecurityHeaders();
  },
};

export default nextConfig;

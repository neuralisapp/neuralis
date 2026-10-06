import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({
  appRoot: '',
  projectsRoot: '',
}));

vi.mock('../../config/env', () => ({
  getEnv: () => ({
    appRoot: roots.appRoot,
    projectsRoot: roots.projectsRoot,
    port: 3100,
    nodeEnv: 'test',
    qdrant: { url: 'http://localhost:6333' },
    auth: { secret: 'test', nextAuthUrl: 'http://localhost:3100', adminEmail: null },
    mcp: { httpPort: 3101, baseUrl: 'http://localhost:3101', appUrl: 'http://localhost:3100' },
  }),
  resolveProjectPackagesDir: (projectRoot: string) => join(projectRoot, '_packages'),
}));

import { assertInstallSourceAllowed } from '../packageInstaller';

describe('package install source boundary', () => {
  let root: string;
  let projectRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'neuralis-install-'));
    roots.appRoot = join(root, 'app');
    roots.projectsRoot = join(root, 'projects');
    projectRoot = join(roots.projectsRoot, 'proj-1');
    mkdirSync(join(roots.appRoot, 'config'), { recursive: true });
    mkdirSync(join(projectRoot, '_packages'), { recursive: true });
  });

  it('rejects sourceRoot inside the platform app zone', () => {
    const sourceRoot = join(roots.appRoot, 'config', 'credentials');
    mkdirSync(sourceRoot, { recursive: true });

    expect(() => assertInstallSourceAllowed({ sourceRoot }, projectRoot)).toThrow(/app data directory/);
  });

  it('rejects sourceRoot inside the target project package directory', () => {
    const sourceRoot = join(projectRoot, '_packages', 'existing');
    mkdirSync(sourceRoot, { recursive: true });

    expect(() => assertInstallSourceAllowed({ sourceRoot }, projectRoot)).toThrow(/target project package directory/);
  });

  it('allows a sourceRoot outside the app zone and target package directory', () => {
    const sourceRoot = join(root, 'authoring', 'my-package');
    mkdirSync(sourceRoot, { recursive: true });

    expect(() => assertInstallSourceAllowed({ sourceRoot }, projectRoot)).not.toThrow();
  });
});

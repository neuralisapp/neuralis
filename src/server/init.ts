import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { getEnv } from './config/env';

export class SetupRequiredError extends Error {
  readonly code = 'SETUP_REQUIRED';

  constructor(message = 'Neuralis setup has not been completed. Run `pnpm neuralis:setup` first.') {
    super(message);
    this.name = 'SetupRequiredError';
  }
}

export async function isSetupComplete(): Promise<boolean> {
  const { appRoot, projectsRoot } = getEnv();
  const requiredDirs = [
    appRoot,
    join(appRoot, 'users'),
    join(appRoot, 'projects'),
    join(appRoot, 'config'),
    join(appRoot, 'config', 'sources'),
    projectsRoot,
  ];

  for (const dir of requiredDirs) {
    if (!await exists(dir)) return false;
  }

  const [userFiles, projectFiles] = await Promise.all([
    listJsonFiles(join(appRoot, 'users')),
    listJsonFiles(join(appRoot, 'projects')),
  ]);

  return userFiles.length > 0 && projectFiles.length > 0;
}

export async function assertSetupComplete(): Promise<void> {
  if (!await isSetupComplete()) {
    throw new SetupRequiredError();
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(target: string): Promise<string[]> {
  try {
    const entries = await readdir(target);
    return entries.filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
}

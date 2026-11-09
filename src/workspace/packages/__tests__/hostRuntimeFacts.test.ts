/**
 * `WorkspaceHostPort.isDocker` is a RUNTIME fact: the workspace page reads the
 * kernel's `detectDocker` on the server and seeds it before any package UI
 * renders. One build runs in the image and as a native host, so a build
 * constant would make a native client claim Docker (the `/mounts` picker).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SRC = fileURLToPath(new URL('../../..', import.meta.url));

describe('WorkspaceHostPort.isDocker — seeded from the server at runtime', () => {
  it('follows the server fact both ways (paired)', async () => {
    vi.resetModules();
    const { workspaceHostPort, seedHostRuntimeFacts } = await import('../buildWorkspaceHostPort');
    seedHostRuntimeFacts({ isDocker: true });
    expect(workspaceHostPort.isDocker).toBe(true);
    seedHostRuntimeFacts({ isDocker: false });
    expect(workspaceHostPort.isDocker).toBe(false);
  }, 15_000); // a cold import of the host-port module graph: ~1 s alone, 5 s+ on a loaded runner — not a performance bound

  it('is false before the page seeds it — never a build-time default', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_NEURALIS_DOCKER', 'true');
    const { workspaceHostPort } = await import('../buildWorkspaceHostPort');
    expect(workspaceHostPort.isDocker).toBe(false);
    vi.unstubAllEnvs();
  });

  it('the workspace page hands the kernel detectDocker answer to the client, and nothing in src reads the build constant', () => {
    const page = readFileSync(join(SRC, 'app', 'workspace', 'page.tsx'), 'utf-8');
    expect(page).toMatch(/isDocker=\{detectDocker\(\)\}/);
    const client = readFileSync(join(SRC, 'app', 'workspace', 'WorkspacePageClient.tsx'), 'utf-8');
    expect(client).toMatch(/seedHostRuntimeFacts\(\{ isDocker \}\)/);
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); }
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, 'utf-8').includes('NEXT_PUBLIC_NEURALIS_DOCKER')) readers.push(full);
      }
    };
    walk(SRC);
    expect(readers).toEqual([]);
  });
});

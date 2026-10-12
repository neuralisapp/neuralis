import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The kernel (`@neuralis/package-system`) is a server-EXTERNAL package, so a
 * React hook it exports, called while the host renders on the server, does not
 * reach the renderer's React (a `useSyncExternalStore` of null on every
 * `/workspace` render). Package UI attaches client-side only; the HOST must
 * never import a kernel hook into its own components. Scope: the whole host
 * `src/` tree (`src/app/**` included); a re-export through another module or a
 * default/dynamic import of the kernel client is out of this guard's reach.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('the host renders no kernel hook', () => {
  it('imports no `use*` export of @neuralis/package-system/client and calls none through a namespace', () => {
    const offenders: string[] = [];
    const files = sources(join(__dirname, '..', '..'));
    // The scan root is `neuralis/src`, not only `src/workspace`.
    expect(files.some((file) => file.includes(`${join('src', 'app')}/`))).toBe(true);
    expect(files.some((file) => file.includes(`${join('src', 'server')}/`))).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@neuralis\/package-system\/client'/g)) {
        for (const name of match[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])) {
          if (/^use[A-Z]/.test(name)) offenders.push(`${file}: ${name}`);
        }
      }
      for (const match of text.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*'@neuralis\/package-system\/client'/g)) {
        if (new RegExp(`\\b${match[1]}\\.use[A-Z]`).test(text)) offenders.push(`${file}: ${match[1]}.use*`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

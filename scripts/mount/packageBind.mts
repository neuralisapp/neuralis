/**
 * The `--pkg` dev mount in the generated docker-compose.override.yml.
 *
 * A package folder the operator develops is BOUND onto the path the image
 * installs that package at — `/neuralis/node_modules/<name>` — so discovery,
 * `require` and ESM `import` all find it the way they find the installed copy:
 * one discovery path, no environment variable, no symlink. A bind is not a
 * symlink, so a module's realpath stays under `/neuralis/node_modules` and its
 * parent walk reaches the image's ONE kernel and ONE React.
 *
 * The folder's OWN `node_modules/` is masked by an anonymous volume: a dev
 * checkout carries its own links (a second kernel copy, or links that only
 * resolve on the host), and an ESM import through them would load a second
 * instance. The anonymous volume starts from the image's content at that path —
 * the dependencies the deploy installed for the package — so the bound folder
 * runs against exactly the tree the image would have given it.
 *
 * Kept beside it: the `/mounts/<slug>` bind and its `NEURALIS_MOUNT_*` pair
 * (the data-source plane — a source rooted at the folder derives its host path
 * from that pair). The two binds point at the same host folder.
 */

/** Where a package's folder is bound inside the container. */
export function packageBindTarget(name: string): string {
  return `/neuralis/node_modules/${name}`;
}

/** The two volume lines of one package bind (8-space list items under `volumes:`). */
export function packageBindLines(hostPath: string, name: string): string[] {
  const target = packageBindTarget(name);
  return [`      - ${hostPath}:${target}`, `      - ${target}/node_modules`];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The host folder bound onto `name`'s package path, or `null`. */
export function packageBindHostPath(content: string, name: string): string | null {
  const m = content.match(new RegExp(`^\\s*- (.+):${escapeRegExp(packageBindTarget(name))}\\s*$`, 'm'));
  return m ? m[1] : null;
}

/** Drop `name`'s bind and its node_modules mask. */
export function removePackageBind(content: string, name: string): string {
  const target = escapeRegExp(packageBindTarget(name));
  return content
    .replace(new RegExp(`^[ \\t]*- .+:${target}[ \\t]*\\n`, 'm'), '')
    .replace(new RegExp(`^[ \\t]*- ${target}/node_modules[ \\t]*\\n`, 'm'), '');
}

const VOLUMES_MARKER = /^(\s*# neuralis-mount-marker:.*\n(?:\s*#.*\n)*)/m;

/** Insert volume lines right after the mount marker block; `null` when the marker is missing. */
export function insertVolumeLines(content: string, lines: readonly string[]): string | null {
  const match = content.match(VOLUMES_MARKER);
  if (!match) return null;
  return content.replace(match[0], `${match[0]}${lines.map((l) => `${l}\n`).join('')}`);
}

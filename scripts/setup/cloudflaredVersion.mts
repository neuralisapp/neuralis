/**
 * The pinned `cloudflared` — the connector `neuralis tunnel` runs. A Docker
 * install runs the image as a compose service; the desktop app's host
 * downloads the binary on the first `tunnel on` into the data home and
 * `neuralis up` supervises it, so the tunnel lives exactly as long as the host.
 *
 * Refresh the pin: `gh api repos/cloudflare/cloudflared/releases/latest` (each
 * asset's `digest` is its sha256 — checked on the day the pin moves), and the
 * Docker Hub tag API for the image index digest
 * (`hub.docker.com/v2/repositories/cloudflare/cloudflared/tags/<version>`).
 */

import { join } from 'node:path';

export const CLOUDFLARED_VERSION = '2026.10.5';

/** The compose image, pinned by its multi-arch index digest (never `latest`). */
export const CLOUDFLARED_IMAGE = `cloudflare/cloudflared:${CLOUDFLARED_VERSION}@sha256:1b1d34d0a9c0bfca9de72db8460d328db3f19edd2b96169114e3e893a97bbe53`;

export type CloudflaredAsset = { url: string; filename: string; sha256: string; unpack: 'raw' | 'tgz' };

/** The release asset for this machine (Linux and Windows a bare executable, macOS a `.tgz`); null where upstream publishes none. */
export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CloudflaredAsset | null {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
  const row = (filename: string, sha256: string, unpack: CloudflaredAsset['unpack']): CloudflaredAsset => ({ url: `${base}/${filename}`, filename, sha256, unpack });
  if (platform === 'linux' && arch === 'x64') return row('cloudflared-linux-amd64', 'e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298', 'raw');
  if (platform === 'linux' && arch === 'arm64') return row('cloudflared-linux-arm64', '72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d', 'raw');
  if (platform === 'darwin' && arch === 'arm64') return row('cloudflared-darwin-arm64.tgz', '184c7d4f5f977348243a6d7ca8f6cf6073b9b2746cfe8c1fe15aa59e9a522bf0', 'tgz');
  if (platform === 'darwin' && arch === 'x64') return row('cloudflared-darwin-amd64.tgz', '6699392fed92367808c248c2d90bed66e49bbf66e1b4ee3e4141230f3f7391b3', 'tgz');
  if (platform === 'win32' && arch === 'x64') return row('cloudflared-windows-amd64.exe', 'db4e4c413612a0916f3e1679d3caaf376f94911952d163028fb726fb2e0516a9', 'raw');
  return null;
}

/**
 * The tunnel's folder in the data home: the account certificate `tunnel login`
 * writes (`cert.pem`), the tunnel's credentials (`<id>.json`), the
 * `config.yml` this install generates, and the pinned binary (`bin/`). Mode
 * 0700: the certificate and the credentials are secrets — never `.env`, never
 * platform config.
 */
export function tunnelDir(home: string): string {
  return join(home, 'app', 'cloudflared');
}

/** The pinned executable in the data home. */
export function cloudflaredExecutable(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(tunnelDir(home), 'bin', CLOUDFLARED_VERSION, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

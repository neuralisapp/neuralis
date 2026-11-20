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

export const CLOUDFLARED_VERSION = '2026.11.1';

/** The compose image, pinned by its multi-arch index digest (never `latest`). */
export const CLOUDFLARED_IMAGE = `cloudflare/cloudflared:${CLOUDFLARED_VERSION}@sha256:e613aadbc2d9511785d2e67a86b0c8ac18dd63a3f9af0d06faf04cbfdcb35f2d`;

export type CloudflaredAsset = { url: string; filename: string; sha256: string; unpack: 'raw' | 'tgz' };

/** The release asset for this machine (Linux and Windows a bare executable, macOS a `.tgz`); null where upstream publishes none. */
export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CloudflaredAsset | null {
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
  const row = (filename: string, sha256: string, unpack: CloudflaredAsset['unpack']): CloudflaredAsset => ({ url: `${base}/${filename}`, filename, sha256, unpack });
  if (platform === 'linux' && arch === 'x64') return row('cloudflared-linux-amd64', '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7', 'raw');
  if (platform === 'linux' && arch === 'arm64') return row('cloudflared-linux-arm64', 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a', 'raw');
  if (platform === 'darwin' && arch === 'arm64') return row('cloudflared-darwin-arm64.tgz', '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462', 'tgz');
  if (platform === 'darwin' && arch === 'x64') return row('cloudflared-darwin-amd64.tgz', '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f', 'tgz');
  if (platform === 'win32' && arch === 'x64') return row('cloudflared-windows-amd64.exe', '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35', 'raw');
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

/**
 * Generic Docker helpers shared between scripts/ and src/.
 *
 * Each helper is zero-cost-optional: if dockerode is not installed or the
 * socket is absent, helpers return typed fallbacks instead of throwing, so
 * the rest of neuralis keeps booting.
 */

export { detectDockerSocketGid } from './socketGid';
export { verifySocketAccessible } from './socketHealth';
export type { SocketHealthLogger, SocketHealthResult } from './socketHealth';
export { resolveSharedNetwork } from './networkDiscovery';
export type { NetworkDiscoveryOpts, NetworkDiscoveryLogger } from './networkDiscovery';
export { pullIfMissing } from './imageEnsure';
export type { PullOpts, PullProgressEvent } from './imageEnsure';
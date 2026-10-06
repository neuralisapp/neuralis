/**
 * Pulls a Docker image if it isn't already present locally.
 *
 * Used by `pnpm setup` to background-prefetch the Webtop image right after the
 * user picks a desktop variant, so the first widget open isn't blocked on a
 * ~3 GB uncompressed pull.
 */

type DockerodeLike = {
  getImage(id: string): { inspect(): Promise<unknown> };
  pull(
    image: string,
    cb: (err: Error | null, stream: NodeJS.ReadableStream) => void,
  ): void;
  modem: {
    followProgress: (
      stream: NodeJS.ReadableStream,
      onDone: (err: Error | null, output?: unknown[]) => void,
      onProgress?: (event: unknown) => void,
    ) => void;
  };
};

export type PullProgressEvent = {
  status?: string;
  progressDetail?: { current?: number; total?: number };
  id?: string;
};

export type PullOpts = {
  /** When true, don't await the pull — return as soon as it's started. */
  background?: boolean;
  /** Progress callback (forwarded raw from dockerode's stream). */
  onProgress?: (event: PullProgressEvent) => void;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
};

export async function pullIfMissing(
  docker: DockerodeLike,
  image: string,
  opts: PullOpts = {},
): Promise<{ pulled: boolean; inBackground: boolean }> {
  try {
    await docker.getImage(image).inspect();
    opts.logger?.info('[docker] image already present', { image });
    return { pulled: false, inBackground: false };
  } catch {
    // not present — pull
  }

  opts.logger?.info('[docker] pulling image', { image, background: !!opts.background });

  const progressBridge = opts.onProgress
    ? (event: unknown) => opts.onProgress!(event as PullProgressEvent)
    : undefined;

  const pullPromise = new Promise<void>((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (finalErr) => (finalErr ? reject(finalErr) : resolve()),
        progressBridge,
      );
    });
  });

  if (opts.background) {
    pullPromise.catch((err) => {
      opts.logger?.warn('[docker] background pull failed', {
        image,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { pulled: false, inBackground: true };
  }

  await pullPromise;
  return { pulled: true, inBackground: false };
}
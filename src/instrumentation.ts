/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * 0. Installs the unclaimed-upgrade watchdog. Before everything else, because
 *    the gap it leaves is a span of TIME, not a set of servers: the prototype
 *    patch reaches servers that are already bound (that is how it covers the app
 *    port, which Next binds before running this hook), but not an upgrade emitted
 *    before this line executes. See `server/upgradeWatchdog.ts`.
 * 1. Installs the SIGTERM/SIGINT graceful-shutdown handlers. FIRST among the
 *    lifecycle steps, and unconditionally: the drain that saves an in-flight
 *    turn is worthless if its registration sits behind a config branch or a
 *    bootstrap that can reject. See `server/host/shutdown.ts` for the two holes
 *    this ordering closes.
 * 2. Pre-warms the in-process package-runtime bootstrap so the warm-up
 *    (discovery, the runtime provider's boot: every package's init/start)
 *    begins at container boot instead of lazily on the first user request.
 *    Until it completes, `/api/health` reports `initializing` and the Docker
 *    healthcheck keeps the container `starting`. `getRuntime()` is an
 *    idempotent singleton, so this shares the in-flight promise with the MCP
 *    server's own call below — no double bootstrap.
 * 2b. Subscribes the principal-revocation signal (`server/host/principalRevocation.ts`)
 *    before the bootstrap resolves, so no disable/delete/removal is missed.
 * 2c. Verifies the project and user record stores once, non-blocking — every
 *    torn or unreadable record is named in the operator log.
 * 3. Starts the host process monitor (CPU + event-loop lag → `perf.slow` in
 *    `docker logs`; `server/logging/processMonitor.ts`) and registers its stop
 *    as a shutdown step. Before the MCP branch, so it runs in every deployment.
 * 4. Starts the community MCP HTTP server on a separate port (default 3101).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // 0. Upgrade watchdog — FIRST, because the uncovered window is a span of TIME,
  // not a set of servers. An HTTP `Upgrade` that no `'upgrade'` listener claims
  // is retained for the life of the process (unauthenticated fd exhaustion), on
  // the app port and the companion port alike. This patches `http`/`https`
  // `Server.prototype.emit` process-wide rather than registering a listener —
  // see the file docstring for why a listener cannot work here.
  //
  // Because `emit` resolves through the prototype at CALL time, the patch covers
  // servers that already exist and are already listening — which is what makes
  // it reach `:3100`: Next's `start-server.js` binds the app port and only then
  // runs `initialize()` → this hook. What is genuinely uncovered is any upgrade
  // EMITTED before this line executes, i.e. a boot window on an already-bound app
  // port — never measured, so it is not quantified here. Hence first.
  const { installUpgradeWatchdog } = await import('./server/upgradeWatchdog');
  installUpgradeWatchdog();
  // Chained on top of the watchdog's hook: stamps the socket peer onto every
  // request (the ONE client-address input) — `server/requestPeerStamp.ts`.
  const { installRequestPeerStamp } = await import('./server/requestPeerStamp');
  installRequestPeerStamp();

  // 1. Signal handlers — before any await that could throw, and before the
  // MCP_HTTP_PORT branch below. Nothing here may depend on a booted core.
  const { installShutdownHandlers, addShutdownStep } = await import('./server/host/shutdown');
  installShutdownHandlers();

  // 2. Fire bootstrap warm-up immediately, non-blocking. Errors are flagged in
  // the bootstrap status (phase='error', surfaced by /api/health) and logged
  // here; they must not crash the instrumentation hook.
  const [{ getRuntime }, { getLogger }] = await Promise.all([
    import('./server/host/bootstrap'),
    import('./server/logging/setup'),
  ]);
  const prewarmLogger = getLogger().child('bootstrap-prewarm');
  void getRuntime().then(() => {
    // Core ready: initialize the manager before its synchronous registry getter.
    // Prewarm the same attachment promise every request uses.
    // Its failure is observed separately from bootstrap rejection.
    const uiLogger = getLogger().child('package-ui-prewarm');
    void import('./server/packages/runtime')
      .then(({ ensureCommunityRuntime }) => ensureCommunityRuntime())
      .then(() => import('./server/packages/packageUiModules'))
      .then(({ getUiAttachments }) => getUiAttachments())
      .catch((err: unknown) => {
        uiLogger.error(`UI pre-warm failed: ${err instanceof Error ? err.name : 'unknown error'}`);
      });
  }, (err: unknown) => {
    prewarmLogger.error(
      `Bootstrap pre-warm failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  // 2b. The package fan-out is the LOADER's; it awaits the same bootstrap singleton per event.
  const { startPrincipalRevocation } = await import('./server/host/principalRevocation');
  startPrincipalRevocation(async (event) => (await getRuntime()).getLoader().revokePrincipalForAll(event));
  // 2c. Store integrity, non-blocking: a torn or unreadable project/user record
  // is named in the operator log by its relative path, with the scan time —
  // otherwise it would only vanish from every list. The catch logs the error
  // NAME only: an fs message carries an absolute path.
  const integrityLogger = getLogger().child('store-integrity');
  void Promise.all([import('./server/store/ProjectStore'), import('./server/store/UserStore')])
    .then(([projects, users]) =>
      Promise.all([projects.verifyProjectRecords(integrityLogger), users.verifyUserRecords(integrityLogger)]))
    .catch((err: unknown) => {
      integrityLogger.error(`Store integrity check failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    });

  // 3. Process monitor — idempotent (globalThis-anchored), unref'd timer.
  const { startProcessMonitor, stopProcessMonitor } = await import('./server/logging/processMonitor');
  startProcessMonitor();
  addShutdownStep('process monitor', stopProcessMonitor);

  // 4. MCP HTTP server — opt-out via MCP_HTTP_PORT. The shutdown handlers are
  // already installed, so this deployment still drains.
  const port = process.env.MCP_HTTP_PORT;
  if (port === '0' || port === 'false') return;

  const { startMcpServer } = await import('./server/mcp/startMcpServer');
  await startMcpServer();
}

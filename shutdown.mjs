function closeServerOnce(closeServer) {
  return new Promise((resolve) => {
    try {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const maybe = closeServer?.(done);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(() => done()).catch(() => done());
        return;
      }
      if (typeof closeServer !== 'function' || closeServer.length === 0) {
        done();
      }
    } catch {
      resolve();
    }
  });
}

export async function cleanupRuntimeResources({
  closeServer,
  stopWatchFolders,
  disposeBrowserBackend
} = {}) {
  await Promise.allSettled([
    closeServerOnce(closeServer),
    Promise.resolve().then(() => stopWatchFolders?.()),
    Promise.resolve().then(() => disposeBrowserBackend?.())
  ]);
}

export function createGracefulShutdown({
  closeServer,
  stopWatchFolders,
  disposeBrowserBackend,
  stopOrchestrators,
  setTabsQuitting,
  markQuitting,
  quitApp
} = {}) {
  let cleanupPromise = null;
  let allowingQuit = false;

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        markQuitting?.();
      } catch {}
      try {
        stopOrchestrators?.();
      } catch {}
      try {
        setTabsQuitting?.();
      } catch {}
      await cleanupRuntimeResources({ closeServer, stopWatchFolders, disposeBrowserBackend });
    })();
    return cleanupPromise;
  }

  async function requestQuit() {
    await cleanup();
    if (allowingQuit) return;
    allowingQuit = true;
    quitApp?.();
  }

  function handleBeforeQuit(event) {
    if (allowingQuit) return;
    try {
      event?.preventDefault?.();
    } catch {}
    void requestQuit();
  }

  return {
    cleanup,
    requestQuit,
    handleBeforeQuit,
    isAllowingQuit: () => allowingQuit
  };
}

export function registerShutdownSignals({ processLike = process, requestQuit } = {}) {
  const handler = () => {
    void requestQuit?.();
  };
  processLike?.on?.('SIGINT', handler);
  processLike?.on?.('SIGTERM', handler);
  return () => {
    try {
      processLike?.removeListener?.('SIGINT', handler);
    } catch {}
    try {
      processLike?.removeListener?.('SIGTERM', handler);
    } catch {}
  };
}

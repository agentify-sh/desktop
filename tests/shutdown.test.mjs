import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { cleanupRuntimeResources, createGracefulShutdown, registerShutdownSignals } from '../shutdown.mjs';

test('shutdown: before-quit waits for async cleanup before quitting', async () => {
  const calls = [];
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });

  const shutdown = createGracefulShutdown({
    closeServer: async () => {
      calls.push('closeServer');
      await cleanupGate;
    },
    stopWatchFolders: async () => {
      calls.push('stopWatchFolders');
      await cleanupGate;
    },
    disposeBrowserBackend: async () => {
      calls.push('disposeBrowserBackend');
      await cleanupGate;
    },
    stopOrchestrators: () => calls.push('stopOrchestrators'),
    setTabsQuitting: () => calls.push('setTabsQuitting'),
    markQuitting: () => calls.push('markQuitting'),
    quitApp: () => calls.push('quitApp')
  });

  let prevented = false;
  shutdown.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, true);
  assert.equal(calls.includes('quitApp'), false);

  releaseCleanup();
  await shutdown.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    calls,
    ['markQuitting', 'stopOrchestrators', 'setTabsQuitting', 'closeServer', 'stopWatchFolders', 'disposeBrowserBackend', 'quitApp']
  );
});

test('shutdown: repeated quit requests do not rerun cleanup', async () => {
  let closeServerCalls = 0;
  let stopWatchCalls = 0;
  let disposeCalls = 0;
  let quitCalls = 0;

  const shutdown = createGracefulShutdown({
    closeServer: () => {
      closeServerCalls += 1;
    },
    stopWatchFolders: () => {
      stopWatchCalls += 1;
    },
    disposeBrowserBackend: () => {
      disposeCalls += 1;
    },
    stopOrchestrators: () => {},
    setTabsQuitting: () => {},
    markQuitting: () => {},
    quitApp: () => {
      quitCalls += 1;
    }
  });

  await shutdown.requestQuit();
  await shutdown.requestQuit();

  assert.equal(closeServerCalls, 1);
  assert.equal(stopWatchCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(quitCalls, 1);
});

test('shutdown: SIGINT and SIGTERM are both forwarded to requestQuit', async () => {
  const fakeProcess = new EventEmitter();
  let quitCalls = 0;
  const unregister = registerShutdownSignals({
    processLike: fakeProcess,
    requestQuit: async () => {
      quitCalls += 1;
    }
  });

  fakeProcess.emit('SIGINT');
  fakeProcess.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(quitCalls, 2);

  unregister();
  fakeProcess.emit('SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(quitCalls, 2);
});

test('shutdown: cleanupRuntimeResources cleans up partially started runtime after startup failure', async () => {
  const calls = [];
  await cleanupRuntimeResources({
    closeServer: () => {
      calls.push('closeServer');
    },
    stopWatchFolders: async () => {
      calls.push('stopWatchFolders');
    },
    disposeBrowserBackend: async () => {
      calls.push('disposeBrowserBackend');
    }
  });

  assert.deepEqual(calls, ['closeServer', 'stopWatchFolders', 'disposeBrowserBackend']);
});

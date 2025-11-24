import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

import { createWorkspaceSdk } from '../workspace-sdk.js';

const repoRoot = process.cwd();
const workspaceRoot = path.join(repoRoot, 'workspace');
const workspaceSdk = createWorkspaceSdk({ workspaceRoot, withDeadline });
let quickjsModulePromise = null;

async function executeCodeBlock(source, timeoutMs, sandboxOptions = {}) {
  const logs = [];
  const quickjs = await loadQuickjsModule();
  const vm = quickjs.newContext();
  const deadlineInfo = createDeadlineInfo(timeoutMs);
  const pendingSdkOperations = new Set();
  const trackSdkOperation = (promise) => {
    if (!promise || typeof promise.then !== 'function') {
      return;
    }
    const tracked = promise.finally(() => {
      pendingSdkOperations.delete(tracked);
    });
    pendingSdkOperations.add(tracked);
  };
  const start = performance.now();

  try {
    if (deadlineInfo) {
      vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadlineInfo.deadline));
    } else {
      vm.runtime.removeInterruptHandler();
    }

    installConsole(vm, logs);
    installSdk(vm, deadlineInfo, trackSdkOperation, sandboxOptions);

    const program = wrapUserSource(source);
    const evalResult = vm.evalCode(program, { filename: 'code-loop-block.js' });

    if (evalResult.error) {
      const errorInfo = convertQuickjsError(vm, evalResult.error);
      evalResult.error.dispose();
      throw new QuickJSExecutionError(errorInfo.message, errorInfo.stack);
    }

    const promiseHandle = evalResult.value;
    const stopJobPump = startQuickjsJobPump(vm);
    let settledResult;
    try {
      settledResult = await withDeadline(vm.resolvePromise(promiseHandle), deadlineInfo, 'code execution');
    } finally {
      stopJobPump();
      promiseHandle.dispose();
    }

    if (settledResult.error) {
      const errorInfo = convertQuickjsError(vm, settledResult.error);
      settledResult.error.dispose();
      throw new QuickJSExecutionError(errorInfo.message, errorInfo.stack);
    }

    const valueHandle = settledResult.value;
    const value = vm.dump(valueHandle);
    valueHandle.dispose();

    const durationMs = performance.now() - start;
    return {
      success: true,
      value,
      logs,
      formattedValue: stringify(value),
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - start;
    return {
      success: false,
      logs,
      errorMessage: error?.message ?? 'QuickJS execution failed',
      errorStack: error.quickjsStack ?? error.stack ?? null,
      durationMs,
    };
  } finally {
    await waitForPendingOperations(pendingSdkOperations);
    vm.dispose();
  }
}

function wrapUserSource(source) {
  return `'use strict';\n(async () => {\n${source}\n})()`;
}

function startQuickjsJobPump(vm) {
  const schedule = typeof setImmediate === 'function'
    ? (fn) => setImmediate(fn)
    : (fn) => setTimeout(fn, 0);
  const cancel = typeof clearImmediate === 'function'
    ? (handle) => clearImmediate(handle)
    : (handle) => clearTimeout(handle);

  let active = true;
  let timer = null;

  const tick = () => {
    timer = null;
    if (!active) {
      return;
    }
    try {
      vm.runtime.executePendingJobs();
    } catch {
      active = false;
      return;
    }
    if (active) {
      timer = schedule(tick);
    }
  };

  tick();

  return () => {
    active = false;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
}

async function loadQuickjsModule() {
  if (!quickjsModulePromise) {
    quickjsModulePromise = getQuickJS();
  }
  return quickjsModulePromise;
}

function installConsole(vm, logs) {
  const consoleHandle = vm.newObject();
  ['log', 'info', 'warn', 'error'].forEach((level) => {
    const fnHandle = vm.newFunction(level, (...args) => {
      const values = handlesToNativeValues(vm, args);
      const text = values.map((value) => stringify(value)).join(' ');
      logs.push({ level, text });
      return vm.undefined;
    });
    vm.setProp(consoleHandle, level, fnHandle);
    fnHandle.dispose();
  });
  vm.setProp(vm.global, 'console', consoleHandle);
  consoleHandle.dispose();
}

function installSdk(vm, deadlineInfo, trackPendingOperation = () => {}, sandboxOptions = {}) {
  const sdkHandle = vm.newObject();

  const projectRootHandle = vm.newString(workspaceSdk.projectRoot);
  vm.setProp(sdkHandle, 'projectRoot', projectRootHandle);
  projectRootHandle.dispose();

  defineAsyncFunction(vm, sdkHandle, 'readFile', async ([maybePath]) => {
    return workspaceSdk.readFile(maybePath, deadlineInfo);
  }, trackPendingOperation);

  defineAsyncFunction(vm, sdkHandle, 'writeFile', async ([maybePath, contents = '']) => {
    return workspaceSdk.writeFile(maybePath, contents, deadlineInfo);
  }, trackPendingOperation);

  defineAsyncFunction(vm, sdkHandle, 'listFiles', async ([maybePath]) => {
    return workspaceSdk.listFiles(maybePath, deadlineInfo);
  }, trackPendingOperation);

  defineAsyncFunction(vm, sdkHandle, 'deletePath', async ([maybePath]) => {
    return workspaceSdk.deletePath(maybePath, deadlineInfo);
  }, trackPendingOperation);

  defineAsyncFunction(vm, sdkHandle, 'exec', async ([command, execOptions]) => {
    return workspaceSdk.exec(command, execOptions, deadlineInfo);
  }, trackPendingOperation);

  if (typeof sandboxOptions.delegateTaskHandler === 'function') {
    defineAsyncFunction(vm, sdkHandle, 'delegateTask', async ([rawInput]) => {
      const payload = rawInput ?? {};
      return withDeadline(
        Promise.resolve().then(() => sandboxOptions.delegateTaskHandler(payload)),
        deadlineInfo,
        'sdk.delegateTask',
      );
    }, trackPendingOperation);
  }

  vm.setProp(vm.global, 'sdk', sdkHandle);
  sdkHandle.dispose();
}

function defineAsyncFunction(vm, targetHandle, name, handler, trackPendingOperation = () => {}) {
  const fnHandle = vm.newFunction(name, (...handles) => {
    const args = handlesToNativeValues(vm, handles);
    const deferred = vm.newPromise();
    const settlement = deferred.settled.then(() => {
      try {
        vm.runtime.executePendingJobs();
      } finally {
        deferred.dispose();
      }
    });
    trackPendingOperation(settlement);

    (async () => {
      try {
        const value = await handler(args);
        const handle = convertToQuickjsHandle(vm, value);
        deferred.resolve(handle);
        disposeHandle(vm, handle);
      } catch (error) {
        const quickjsError = buildQuickjsErrorHandle(vm, error);
        deferred.reject(quickjsError);
        quickjsError.dispose();
      }
    })();

    return deferred.handle;
  });

  vm.setProp(targetHandle, name, fnHandle);
  fnHandle.dispose();
}

function handlesToNativeValues(vm, handles) {
  return handles.map((handle) => {
    const value = vm.dump(handle);
    handle.dispose();
    return value;
  });
}

function convertToQuickjsHandle(vm, value) {
  if (value === undefined) {
    return vm.undefined;
  }
  if (value === null) {
    return vm.null;
  }
  if (typeof value === 'string') {
    return vm.newString(value);
  }
  if (typeof value === 'number') {
    return vm.newNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? vm.true : vm.false;
  }
  if (Array.isArray(value)) {
    const arrayHandle = vm.newArray();
    value.forEach((item, index) => {
      const itemHandle = convertToQuickjsHandle(vm, item);
      vm.setProp(arrayHandle, index, itemHandle);
      disposeHandle(vm, itemHandle);
    });
    return arrayHandle;
  }
  if (typeof value === 'object') {
    const objectHandle = vm.newObject();
    Object.entries(value).forEach(([key, val]) => {
      const valHandle = convertToQuickjsHandle(vm, val);
      vm.setProp(objectHandle, key, valHandle);
      disposeHandle(vm, valHandle);
    });
    return objectHandle;
  }
  return vm.undefined;
}

function disposeHandle(vm, handle) {
  if (!handle) {
    return;
  }
  if (handle === vm.undefined || handle === vm.null || handle === vm.true || handle === vm.false) {
    return;
  }
  if (typeof handle.dispose === 'function') {
    handle.dispose();
  }
}

function buildQuickjsErrorHandle(vm, error) {
  const message = error?.message ?? String(error);
  const errorHandle = vm.newError(message);
  if (error?.stack) {
    const stackHandle = vm.newString(error.stack);
    vm.setProp(errorHandle, 'stack', stackHandle);
    stackHandle.dispose();
  }
  return errorHandle;
}

function convertQuickjsError(vm, errorHandle) {
  const messageHandle = vm.getProp(errorHandle, 'message');
  const stackHandle = vm.getProp(errorHandle, 'stack');
  const rawMessage = messageHandle ? vm.dump(messageHandle) : vm.dump(errorHandle);
  const rawStack = stackHandle ? vm.dump(stackHandle) : null;
  if (messageHandle) {
    messageHandle.dispose();
  }
  if (stackHandle) {
    stackHandle.dispose();
  }
  return {
    message: typeof rawMessage === 'string' ? rawMessage : stringify(rawMessage),
    stack: typeof rawStack === 'string' ? rawStack : null,
  };
}

class QuickJSExecutionError extends Error {
  constructor(message, stackTrace) {
    super(message);
    this.name = 'QuickJSExecutionError';
    this.quickjsStack = stackTrace ?? null;
    if (stackTrace) {
      this.stack = stackTrace;
    }
  }
}

function createDeadlineInfo(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return {
    timeoutMs,
    deadline: Date.now() + timeoutMs,
  };
}

function withDeadline(promise, deadlineInfo, contextLabel, options = {}) {
  if (!deadlineInfo) {
    return promise;
  }
  const remaining = deadlineInfo.deadline - Date.now();
  if (remaining <= 0) {
    if (options.abortController) {
      options.abortController.abort();
    }
    return Promise.reject(createTimeoutError(contextLabel, deadlineInfo.timeoutMs));
  }

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (options.abortController) {
        options.abortController.abort();
      }
      reject(createTimeoutError(contextLabel, deadlineInfo.timeoutMs));
    }, Math.max(1, remaining));
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function createTimeoutError(contextLabel, timeoutMs) {
  const suffix = timeoutMs ? ` after ${timeoutMs} ms` : '';
  return new Error(`${contextLabel ?? 'Execution'} timed out${suffix}`);
}

async function waitForPendingOperations(pendingOperations) {
  if (!pendingOperations || pendingOperations.size === 0) {
    return;
  }
  await Promise.allSettled([...pendingOperations]);
}

function stringify(value) {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

export {
  executeCodeBlock,
  withDeadline,
};

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const DEFAULT_MODEL = process.env.CODE_LOOP_MODEL ?? 'gpt-5.1-codex-mini';
const DEFAULT_MAX_ITERATIONS = Number(process.env.CODE_LOOP_MAX_ITERATIONS ?? 12);
const DEFAULT_EXEC_TIMEOUT = Number(process.env.CODE_LOOP_TIMEOUT_MS ?? 8000);

const SYSTEM_PROMPT = `You are the built-in AI agent inside our to-do app. Keep guidance tight, pragmatic, and centered on helping the user plan and finish their tasks.

Use plain text when conversation alone solves the request. When you need to touch data, respond with one or more fenced \`\`\`js blocks containing standalone async JavaScript-each block runs in a fresh runtime, can await the SDK, and must \`return\` the value you want surfaced (e.g., \`return await sdk.listTodos();\`). Once you send a reply with no \`\`\`js blocks, the current exchange ends, so include every snippet you still need before switching back to plain text.

Important communication rules:
1. Before you emit any \`\`\`js block, briefly explain to the user (in plain text) what you are about to do and why, so they can follow along even if they do not read the code.
2. Execution results for each code block are delivered to you as the next user message. Do not say a task is finished or describe side effects until you have read that feedback. After running code, either stop speaking or state that you are waiting for results, then use the following turn to confirm the outcome based on the returned data.

Todo helpers on the global sdk object:
- sdk.createTodo(input) => Promise<Todo>
- sdk.getTodo(id) => Promise<Todo | null>
- sdk.listTodos() => Promise<Todo[]>
- sdk.updateTodo(id, patch) => Promise<Todo>
- sdk.deleteTodo(id) => Promise<boolean>
- sdk.searchTodos(criteria) => Promise<Todo[]>

A Todo has { id, title, description, done, tags[], dueDate|null, createdAt, updatedAt }. The data lives on the filesystem, so treat the SDK as the source of truth. You have generous degrees of freedom-think ahead, chain helpers creatively when it helps, and always report the key state changes or findings back to the user.`;

const projectRoot = process.cwd();
const todosDirectory = path.join(projectRoot, 'data');
const todosDbPath = path.join(todosDirectory, 'todos.json');
let quickjsModulePromise = null;

export async function run() {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  assertApiKey();

  const session = new AgentSession(options);

  if (options.prompt) {
    await session.submit(options.prompt.trim());
    return;
  }

  await runInteractive(session);
}

class AgentSession {
  constructor(options) {
    this.options = options;
    this.messages = [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
    ];
  }

  async submit(text) {
    if (!text) {
      return;
    }

    this.messages.push({ role: 'user', content: text });
    return this.loop();
  }

  async loop() {
    let iteration = 0;
    while (iteration < this.options.maxIterations) {
      iteration += 1;
      const { outputText, finishReason, codeBlocks } = await this.invokeModel();

      if (!codeBlocks.length) {
        if (!this.options.stream && outputText.trim()) {
          console.log(`\nassistant> ${outputText.trim()}\n`);
        }
        if (this.options.prompt) {
          return { finishReason, iteration };
        }
        return;
      }

      let blockIndex = 0;
      for (const block of codeBlocks) {
        blockIndex += 1;
        const result = await executeCodeBlock(block, this.options.executionTimeoutMs);
        logExecution(result, blockIndex);
        this.messages.push({
          role: 'user',
          content: formatExecutionFeedback(result, blockIndex),
        });
      }
    }

    console.warn('Reached max iteration limit without receiving a plain-text reply.');
  }

  async invokeModel() {
    const modelOptions = {
      model: openai(this.options.model),
      messages: this.messages,
      providerOptions: {
        openai: {
          reasoningEffort: this.options.reasoningEffort,
          verbosity: this.options.verbosity,
        },
      },
      maxOutputTokens: this.options.maxOutputTokens,
    };

    const result = streamText(modelOptions);

    let outputText = '';
    if (this.options.stream) {
      process.stdout.write('\nassistant> ');
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          process.stdout.write(chunk.text);
          outputText += chunk.text;
        }
      }
      process.stdout.write('\n');
    }

    const responseMessages = (await result.response).messages;
    this.messages.push(...responseMessages);

    if (!this.options.stream) {
      outputText = responseMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => coerceContentToText(message.content))
        .join('\n');
    }

    const finishReason = await result.finishReason;
    const codeBlocks = extractCodeBlocks(outputText);
    return { outputText, finishReason, codeBlocks };
  }
}

function parseCliArgs(argv) {
  const options = {
    prompt: null,
    model: DEFAULT_MODEL,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    executionTimeoutMs: DEFAULT_EXEC_TIMEOUT,
    stream: true,
    reasoningEffort: process.env.CODE_LOOP_REASONING ?? 'medium',
    verbosity: process.env.CODE_LOOP_VERBOSITY ?? 'medium',
    temperature: Number(process.env.CODE_LOOP_TEMPERATURE ?? 0),
    maxOutputTokens: Number(process.env.CODE_LOOP_MAX_OUTPUT ?? 1024),
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--prompt':
      case '-p':
        options.prompt = argv[i + 1] ?? '';
        i += 1;
        break;
      case '--model':
        options.model = argv[i + 1] ?? options.model;
        i += 1;
        break;
      case '--max-iterations':
        options.maxIterations = Number(argv[i + 1] ?? options.maxIterations);
        i += 1;
        break;
      case '--timeout':
        options.executionTimeoutMs = Number(argv[i + 1] ?? options.executionTimeoutMs);
        i += 1;
        break;
      case '--no-stream':
        options.stream = false;
        break;
      case '--reasoning':
        options.reasoningEffort = argv[i + 1] ?? options.reasoningEffort;
        i += 1;
        break;
      case '--verbosity':
        options.verbosity = argv[i + 1] ?? options.verbosity;
        i += 1;
        break;
      case '--temperature':
        options.temperature = Number(argv[i + 1] ?? options.temperature);
        i += 1;
        break;
      case '--max-output-tokens':
        options.maxOutputTokens = Number(argv[i + 1] ?? options.maxOutputTokens);
        i += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        console.warn(`Ignoring positional argument: ${arg}. Use --prompt/-p for single-shot mode.`);
        break;
    }
  }

  options.maxIterations = ensurePositiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  options.executionTimeoutMs = ensurePositiveInteger(options.executionTimeoutMs, DEFAULT_EXEC_TIMEOUT);
  options.maxOutputTokens = ensurePositiveInteger(options.maxOutputTokens, 1024);
  options.temperature = Number.isFinite(options.temperature) ? options.temperature : 0;

  return options;
}

function printHelp() {
  console.log(`Usage: code-loop [options]\n\n` +
    'Options:\n' +
    '  -p, --prompt <text>         Run a single-shot prompt and exit when no more code blocks\n' +
    '  --model <model>            Override the OpenAI model ID\n' +
    '  --max-iterations <n>       Cap the agent loop iterations (default 12)\n' +
    '  --timeout <ms>             Per-code-block execution timeout (default 8000)\n' +
    '  --no-stream                Disable token streaming\n' +
    '  --reasoning <level>        Set provider reasoning effort (default medium)\n' +
    '  --verbosity <level>        Set provider verbosity hint (default medium)\n' +
    '  --temperature <value>      Sampling temperature (default 0)\n' +
    '  --max-output-tokens <n>    Upper bound for model tokens (default 1024)\n' +
    '  -h, --help                 Show this message');
}

async function runInteractive(session) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('Interactive mode. Type :exit to quit.');

  while (true) {
    const answer = await rl.question('you> ');
    const trimmed = answer.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === ':exit' || trimmed === ':q') {
      break;
    }

    try {
      await session.submit(trimmed);
    } catch (error) {
      console.error('Agent loop failed:', error);
    }
  }

  await rl.close();
}

function extractCodeBlocks(text) {
  const codeBlocks = [];
  const regex = /```(?:javascript|js|ts)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const body = match[1];
    if (body && body.trim()) {
      codeBlocks.push(body.trim());
    }
  }
  return codeBlocks;
}


async function executeCodeBlock(source, timeoutMs) {
  const logs = [];
  const quickjs = await loadQuickjsModule();
  const vm = quickjs.newContext();
  const deadlineInfo = createDeadlineInfo(timeoutMs);
  const start = performance.now();

  try {
    if (deadlineInfo) {
      vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadlineInfo.deadline));
    } else {
      vm.runtime.removeInterruptHandler();
    }

    installConsole(vm, logs);
    installSdk(vm, deadlineInfo);

    const program = wrapUserSource(source);
    const evalResult = vm.evalCode(program, { filename: 'code-loop-block.js' });

    if (evalResult.error) {
      const errorInfo = convertQuickjsError(vm, evalResult.error);
      evalResult.error.dispose();
      throw new QuickJSExecutionError(errorInfo.message, errorInfo.stack);
    }

    const promiseHandle = evalResult.value;
    const settledResult = await withDeadline(vm.resolvePromise(promiseHandle), deadlineInfo, 'code execution');
    promiseHandle.dispose();

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
    vm.dispose();
  }
}

function wrapUserSource(source) {
  return `'use strict';
(async () => {
${source}
})()`;
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

function installSdk(vm, deadlineInfo) {
  const sdkHandle = vm.newObject();

  const projectRootHandle = vm.newString(projectRoot);
  vm.setProp(sdkHandle, 'projectRoot', projectRootHandle);
  projectRootHandle.dispose();

  defineAsyncFunction(vm, sdkHandle, 'readFile', async ([maybePath]) => {
    if (typeof maybePath !== 'string' || !maybePath) {
      throw new Error('readFile requires a path argument.');
    }
    const absolute = resolvePath(maybePath);
    return withDeadline(fs.readFile(absolute, 'utf8'), deadlineInfo, 'readFile');
  });

  defineAsyncFunction(vm, sdkHandle, 'writeFile', async ([maybePath, contents = '']) => {
    if (typeof maybePath !== 'string' || !maybePath) {
      throw new Error('writeFile requires a path argument.');
    }
    const absolute = resolvePath(maybePath);
    const text = typeof contents === 'string' ? contents : stringify(contents);
    await withDeadline(fs.mkdir(path.dirname(absolute), { recursive: true }), deadlineInfo, 'writeFile');
    await withDeadline(fs.writeFile(absolute, text, 'utf8'), deadlineInfo, 'writeFile');
    return `Wrote ${text.length} characters to ${path.relative(projectRoot, absolute)}`;
  });

  defineAsyncFunction(vm, sdkHandle, 'listFiles', async ([maybePath]) => {
    const relativePath = typeof maybePath === 'string' && maybePath.length ? maybePath : '.';
    const absolute = resolvePath(relativePath);
    const entries = await withDeadline(fs.readdir(absolute, { withFileTypes: true }), deadlineInfo, 'listFiles');
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }));
  });

  defineAsyncFunction(vm, sdkHandle, 'fetch', async ([url]) => {
    if (typeof url !== 'string' || !url) {
      throw new Error('fetch requires a url argument.');
    }
    const controller = deadlineInfo ? new AbortController() : null;
    const response = await withDeadline(
      fetch(url, controller ? { signal: controller.signal } : undefined),
      deadlineInfo,
      'fetch',
      { abortController: controller },
    );
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return withDeadline(response.json(), deadlineInfo, 'fetch', { abortController: controller });
  });

  defineAsyncFunction(vm, sdkHandle, 'createTodo', async ([payload]) => {
    const todoData = normalizeNewTodoInput(payload);
    const todos = await readTodosFromDisk(deadlineInfo);
    const now = new Date().toISOString();
    const todo = {
      id: randomUUID(),
      ...todoData,
      createdAt: now,
      updatedAt: now,
    };
    todos.push(todo);
    await writeTodosToDisk(todos, deadlineInfo);
    return todo;
  });

  defineAsyncFunction(vm, sdkHandle, 'getTodo', async ([maybeId]) => {
    const id = ensureTodoId(maybeId, 'getTodo');
    const todos = await readTodosFromDisk(deadlineInfo);
    return todos.find((todo) => todo.id === id) ?? null;
  });

  defineAsyncFunction(vm, sdkHandle, 'listTodos', async () => {
    return readTodosFromDisk(deadlineInfo);
  });

  defineAsyncFunction(vm, sdkHandle, 'updateTodo', async ([maybeId, patch]) => {
    const id = ensureTodoId(maybeId, 'updateTodo');
    const todos = await readTodosFromDisk(deadlineInfo);
    const index = todos.findIndex((todo) => todo.id === id);
    if (index === -1) {
      throw new Error(`Todo ${id} not found.`);
    }
    const updated = applyTodoPatch(todos[index], patch);
    todos[index] = updated;
    await writeTodosToDisk(todos, deadlineInfo);
    return updated;
  });

  defineAsyncFunction(vm, sdkHandle, 'deleteTodo', async ([maybeId]) => {
    const id = ensureTodoId(maybeId, 'deleteTodo');
    const todos = await readTodosFromDisk(deadlineInfo);
    const index = todos.findIndex((todo) => todo.id === id);
    if (index === -1) {
      return false;
    }
    todos.splice(index, 1);
    await writeTodosToDisk(todos, deadlineInfo);
    return true;
  });

  defineAsyncFunction(vm, sdkHandle, 'searchTodos', async ([criteria]) => {
    const todos = await readTodosFromDisk(deadlineInfo);
    const normalizedCriteria = normalizeSearchCriteria(criteria);
    if (!normalizedCriteria) {
      return todos;
    }
    return todos.filter((todo) => todoMatchesCriteria(todo, normalizedCriteria));
  });

  vm.setProp(vm.global, 'sdk', sdkHandle);
  sdkHandle.dispose();
}

function defineAsyncFunction(vm, targetHandle, name, handler) {
  const fnHandle = vm.newFunction(name, (...handles) => {
    const args = handlesToNativeValues(vm, handles);
    const deferred = vm.newPromise();
    deferred.settled.then(() => vm.runtime.executePendingJobs());

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

function resolvePath(relativePath) {
  if (!relativePath) {
    return projectRoot;
  }
  return path.isAbsolute(relativePath) ? relativePath : path.join(projectRoot, relativePath);
}

async function readTodosFromDisk(deadlineInfo) {
  let data;
  try {
    data = await withDeadline(fs.readFile(todosDbPath, 'utf8'), deadlineInfo, 'readTodos');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error('Todo database is corrupted.');
  }
}

async function writeTodosToDisk(todos, deadlineInfo) {
  await withDeadline(fs.mkdir(todosDirectory, { recursive: true }), deadlineInfo, 'writeTodos');
  const payload = JSON.stringify(todos, null, 2);
  await withDeadline(fs.writeFile(todosDbPath, payload, 'utf8'), deadlineInfo, 'writeTodos');
  return todos;
}

function normalizeNewTodoInput(raw) {
  if (raw !== null && typeof raw === 'object') {
    return {
      title: normalizeTitle(raw.title, 'Untitled task'),
      description: typeof raw.description === 'string' ? raw.description : '',
      done: typeof raw.done === 'boolean' ? raw.done : false,
      tags: normalizeTags(raw.tags),
      dueDate: normalizeDueDate(raw.dueDate),
    };
  }

  return {
    title: 'Untitled task',
    description: '',
    done: false,
    tags: [],
    dueDate: null,
  };
}

function ensureTodoId(value, fnName) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  throw new Error(`${fnName} requires a non-empty todo id.`);
}

function applyTodoPatch(todo, patchInput) {
  const patch = normalizeTodoPatch(patchInput);
  const updatedAt = new Date().toISOString();
  return {
    ...todo,
    ...patch,
    updatedAt,
  };
}

function normalizeTodoPatch(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('updateTodo requires a patch object.');
  }

  const patch = {};
  if ('title' in raw) {
    patch.title = normalizeTitle(raw.title);
  }
  if ('description' in raw) {
    patch.description = typeof raw.description === 'string' ? raw.description : '';
  }
  if ('done' in raw) {
    patch.done = Boolean(raw.done);
  }
  if ('tags' in raw) {
    patch.tags = normalizeTags(raw.tags);
  }
  if ('dueDate' in raw) {
    patch.dueDate = normalizeDueDate(raw.dueDate);
  }
  return patch;
}

function normalizeTitle(value, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length) {
      return trimmed;
    }
  }
  if (typeof fallback === 'string' && fallback.length) {
    return fallback;
  }
  throw new Error('Todo title must be a non-empty string.');
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  tags.forEach((tag) => {
    const candidate = typeof tag === 'string' ? tag.trim() : String(tag ?? '').trim();
    if (!candidate) {
      return;
    }
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) {
      return;
    }
    seen.add(lower);
    normalized.push(candidate);
  });
  return normalized;
}

function normalizeDueDate(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('dueDate must be a valid date/time value.');
  }
  return date.toISOString();
}

function normalizeSearchCriteria(criteria) {
  if (criteria === undefined || criteria === null) {
    return null;
  }
  if (typeof criteria === 'string') {
    const text = criteria.trim().toLowerCase();
    return text ? { text, tags: [], done: undefined } : null;
  }
  if (typeof criteria !== 'object') {
    throw new Error('searchTodos expects a string or object criteria.');
  }

  const normalized = {
    text: typeof criteria.text === 'string' ? criteria.text.trim().toLowerCase() :
      (typeof criteria.query === 'string' ? criteria.query.trim().toLowerCase() : ''),
    tags: Array.isArray(criteria.tags) ? normalizeTags(criteria.tags).map((tag) => tag.toLowerCase()) : [],
    done: typeof criteria.done === 'boolean' ? criteria.done : undefined,
  };

  if (!normalized.text && !normalized.tags.length && typeof normalized.done === 'undefined') {
    return null;
  }
  return normalized;
}

function todoMatchesCriteria(todo, criteria) {
  if (criteria.text) {
    const haystack = `${todo.title}\n${todo.description}\n${(todo.tags ?? []).join(' ')}`.toLowerCase();
    if (!haystack.includes(criteria.text)) {
      return false;
    }
  }

  if (criteria.tags && criteria.tags.length) {
    const todoTags = (todo.tags ?? []).map((tag) => tag.toLowerCase());
    const hasAllTags = criteria.tags.every((tag) => todoTags.includes(tag));
    if (!hasAllTags) {
      return false;
    }
  }

  if (typeof criteria.done === 'boolean' && todo.done !== criteria.done) {
    return false;
  }

  return true;
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

function formatExecutionFeedback(result, blockIndex) {
  const header = result.success
    ? `Execution result for block ${blockIndex} (Duration ${result.durationMs.toFixed(1)} ms)`
    : `Execution error for block ${blockIndex} (Duration ${result.durationMs.toFixed(1)} ms)`;

  const consoleSection = result.logs.length
    ? result.logs.map((log) => `[${log.level}] ${log.text}`).join('\n')
    : '(no console output)';

  if (result.success) {
    return `${header}\nReturn Value:\n${result.formattedValue}\nConsole:\n${consoleSection}`;
  }

  return `${header}\nError: ${result.errorMessage}\nStack: ${result.errorStack ?? 'n/a'}\nConsole:\n${consoleSection}`;
}

function logExecution(result, blockIndex) {
  if (result.success) {
    console.log(`\n[code block ${blockIndex}] OK (${result.durationMs.toFixed(1)} ms)`);
    if (result.formattedValue) {
      console.log(`return> ${result.formattedValue}`);
    }
  } else {
    console.log(`\n[code block ${blockIndex}] ERROR (${result.durationMs.toFixed(1)} ms)`);
    console.log(`message> ${result.errorMessage}`);
    if (result.errorStack) {
      console.log(result.errorStack);
    }
  }

  if (result.logs.length) {
    console.log('console>');
    result.logs.forEach((log) => {
      console.log(`  [${log.level}] ${log.text}`);
    });
  }
}

function coerceContentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part) {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return content.text;
  }
  return '';
}

function assertApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in the environment.');
  }
}

function ensurePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

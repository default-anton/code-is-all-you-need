import 'dotenv/config';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { systemPrompt } from './prompts.js';
import { theme } from './ui/theme.js';
import { parseCliArgs, printHelp } from './options.js';
import { AgentSession } from './agent/session.js';

export async function run() {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  assertApiKey();

  console.log(`${theme.heading('Model:')} ${theme.strong(options.mainAgentModel)}`);

  const delegateTaskHandler = createDelegateTaskHandler(options);
  const session = new AgentSession({
    ...options,
    model: options.mainAgentModel,
    systemPrompt: systemPrompt(),
    delegateTaskHandler,
  });

  let activeReadline = null;
  const registerReadline = (rl) => {
    activeReadline = rl;
    rl.once('close', () => {
      if (activeReadline === rl) {
        activeReadline = null;
      }
    });
  };

  const handleSigint = () => {
    if (activeReadline && !activeReadline.closed) {
      activeReadline.close();
    }
    console.log();
    console.log(theme.muted('Interrupted. Exiting gracefully.'));
    process.exit(0);
  };

  process.once('SIGINT', handleSigint);

  try {
    if (options.prompt) {
      await session.submit(options.prompt.trim());
      return;
    }

    await runInteractive(session, registerReadline);
  } finally {
    process.off('SIGINT', handleSigint);
  }
}

async function runInteractive(session, onReadlineReady = () => {}) {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdout.isTTY),
    historySize: 1000,
  });
  onReadlineReady(rl);
  const editorCommand = resolveEditorCommand();
  console.log(`${theme.heading('Interactive mode.')} ${theme.muted(`Type :exit to quit, :edit to compose in ${editorCommand}.`)}`);
  const promptLabel = `${theme.accent('you>')} `;

  while (true) {
    const answer = await rl.question(promptLabel);
    const trimmed = answer.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === ':exit' || trimmed === ':q') {
      break;
    }
    if (trimmed === ':edit' || trimmed === ':e') {
      try {
        await withReadlineSuspended(rl, async () => {
          const lastAssistant = typeof session.getLastAssistantMessage === 'function'
            ? session.getLastAssistantMessage()
            : '';
          const editorInput = await captureInputViaEditor({
            assistantMessage: lastAssistant,
            editorCommand,
          });
          const normalized = editorInput.trim();
          if (!normalized) {
            console.log(theme.muted('Editor closed without any input. Nothing sent.'));
            return;
          }
          await session.submit(normalized);
        });
      } catch (error) {
        console.error(theme.error('Failed to open editor:'), error?.message ?? error);
      }
      continue;
    }

    try {
      await session.submit(trimmed);
    } catch (error) {
      console.error(theme.error('Agent loop failed:'), error);
    }
  }

  if (!rl.closed) {
    rl.close();
  }
}

function assertApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in the environment.');
  }
}

function createDelegateTaskHandler(baseOptions) {
  const sanitizedBase = { ...baseOptions };
  return async function delegateTask(rawInput) {
    const normalizedInput = normalizeDelegateTaskInput(rawInput, sanitizedBase.maxIterations);
    const headline = normalizedInput.task.length > 120
      ? `${normalizedInput.task.slice(0, 117)}...`
      : normalizedInput.task;
    console.log(`\n${theme.heading('[delegate] Launching sub-agent')}`);
    console.log(`${theme.label('task>')} ${headline}`);
    const delegateSession = new AgentSession({
      ...sanitizedBase,
      model: sanitizedBase.delegateModel,
      prompt: null,
      systemPrompt: systemPrompt({ mainAgent: false }),
      maxIterations: normalizedInput.maxIterations,
      delegateTaskHandler: null,
    });

    const delegatePrompt = buildDelegateUserPrompt(normalizedInput);
    await delegateSession.submit(delegatePrompt);

    const result = parseDelegateAgentResult(delegateSession.messages);
    console.log(`${theme.label('[delegate] done>')} ${result.summary}`);
    return result;
  };
}

function normalizeDelegateTaskInput(rawInput, maxIterationsCap = 6) {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('sdk.delegateTask requires an input object.');
  }
  const task = typeof rawInput.task === 'string' ? rawInput.task.trim() : '';
  if (!task) {
    throw new Error('sdk.delegateTask requires a non-empty task string.');
  }

  const cap = (() => {
    const numericCap = Number(maxIterationsCap);
    if (Number.isFinite(numericCap) && numericCap > 0) {
      return Math.floor(numericCap);
    }
    return 6;
  })();

  const requestedIterations = Number(rawInput.maxIterations);
  const fallbackIterations = cap;
  const normalizedIterations = Number.isFinite(requestedIterations) && requestedIterations > 0
    ? Math.floor(requestedIterations)
    : fallbackIterations;
  const effectiveIterations = Math.max(1, Math.min(normalizedIterations, cap));

  const contextArtifacts = Array.isArray(rawInput.contextArtifacts)
    ? rawInput.contextArtifacts
      .map((artifact) => {
        if (!artifact || typeof artifact !== 'object') {
          return null;
        }
        const pathText = typeof artifact.path === 'string' ? artifact.path.trim() : '';
        if (!pathText) {
          return null;
        }
        const descriptionText = typeof artifact.description === 'string'
          ? artifact.description.trim()
          : '';
        const updatedText = typeof artifact.last_updated === 'string'
          ? artifact.last_updated.trim()
          : '';
        return {
          path: pathText,
          description: descriptionText || undefined,
          last_updated: updatedText || undefined,
        };
      })
      .filter(Boolean)
    : [];

  return {
    task,
    contextArtifacts,
    maxIterations: effectiveIterations,
  };
}

function buildDelegateUserPrompt(input) {
  const lines = [];
  lines.push('You are a delegated sub-agent. Complete the assigned task end-to-end.');
  lines.push('');
  lines.push('Task:');
  lines.push(input.task);
  lines.push('');
  if (input.contextArtifacts.length) {
    lines.push('Relevant artifacts (read via sdk.readFile as needed):');
    input.contextArtifacts.forEach((artifact, index) => {
      const desc = artifact.description ? ` — ${artifact.description}` : '';
      const updated = artifact.last_updated ? ` (last updated ${artifact.last_updated})` : '';
      lines.push(`  ${index + 1}. ${artifact.path}${desc}${updated}`);
    });
    lines.push('');
  }
  lines.push(`You have up to ${input.maxIterations} agent iterations.`);
  lines.push('Write or update Markdown artifacts under artifacts/ for any non-trivial work.');
  lines.push('Do not call sdk.delegateTask (it is unavailable).');
  lines.push('When finished, respond with JSON (no code fence) shaped as:');
  lines.push('{"success": boolean, "summary": string, "artifacts": [{"path": string, "description"?: string, "last_updated"?: string}] }');
  lines.push('The summary should be a concise status update for the delegating agent.');
  lines.push('List every artifact you created or touched in the array (empty array if none).');
  return lines.join('\n');
}

function parseDelegateAgentResult(messages) {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!lastAssistant) {
    return {
      success: false,
      summary: 'Delegate agent did not produce a final response.',
      artifacts: [],
    };
  }

  const rawText = coerceContentToText(lastAssistant.content).trim();
  const parsed = tryParseDelegateJson(rawText);
  if (!parsed) {
    return {
      success: false,
      summary: rawText || 'Delegate agent returned an empty response.',
      artifacts: [],
    };
  }

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : rawText;
  const artifacts = Array.isArray(parsed.artifacts)
    ? parsed.artifacts
      .map(normalizeArtifactDescriptor)
      .filter(Boolean)
    : [];
  const success = typeof parsed.success === 'boolean' ? parsed.success : true;

  return { success, summary, artifacts };
}

function tryParseDelegateJson(text) {
  if (!text) {
    return null;
  }
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenceMatch ? fenceMatch[1].trim() : text;
  try {
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}

function normalizeArtifactDescriptor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const pathText = typeof value.path === 'string' ? value.path.trim() : '';
  if (!pathText) {
    return null;
  }
  const descriptionText = typeof value.description === 'string' ? value.description.trim() : '';
  const lastUpdatedText = typeof value.last_updated === 'string' ? value.last_updated.trim() : '';
  return {
    path: pathText,
    description: descriptionText || undefined,
    last_updated: lastUpdatedText || undefined,
  };
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

const EDITOR_SEPARATOR_LINE = '--- assistant context (read-only) ---';
const EDITOR_USER_BUFFER_LINES = 6;

function resolveEditorCommand() {
  const editor = process.env.VISUAL?.trim()
    || process.env.EDITOR?.trim()
    || 'nano';
  return editor;
}

async function captureInputViaEditor({ assistantMessage = '', editorCommand }) {
  const tokens = splitEditorCommand(editorCommand);
  if (!tokens.length) {
    throw new Error('No editor command configured. Set $VISUAL or $EDITOR.');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-loop-input-'));
  const tempFile = path.join(tempDir, 'message.txt');
  await fs.writeFile(tempFile, buildEditorTemplate(assistantMessage), 'utf8');

  try {
    await launchEditorProcess(tokens, tempFile);
    const finalText = await fs.readFile(tempFile, 'utf8');
    return extractEditorUserInput(finalText);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildEditorTemplate(assistantMessage) {
  const normalizedAssistant = assistantMessage.replace(/\r\n/g, '\n');
  const lines = Array.from({ length: EDITOR_USER_BUFFER_LINES }, () => '');
  lines.push(EDITOR_SEPARATOR_LINE);
  if (normalizedAssistant) {
    lines.push('# Last assistant message (read-only)');
    normalizedAssistant.split('\n').forEach((line) => {
      lines.push(`# ${line}`);
    });
  } else {
    lines.push('# No assistant message yet.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function extractEditorUserInput(rawText) {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const separatorIndex = lines.findIndex((line) => line.trim() === EDITOR_SEPARATOR_LINE);
  const contentLines = separatorIndex >= 0
    ? lines.slice(0, separatorIndex)
    : lines;
  return contentLines.join('\n').trim();
}

function splitEditorCommand(command) {
  const trimmed = command?.trim();
  if (!trimmed) {
    return [];
  }

  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (quote) {
      if (char === '\\' && i + 1 < trimmed.length) {
        current += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === '\\' && i + 1 < trimmed.length) {
      current += trimmed[i + 1];
      i += 1;
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function launchEditorProcess(tokens, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(tokens[0], [...tokens.slice(1), filePath], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(new Error(`Editor terminated with signal ${signal}`));
        return;
      }
      reject(new Error(`Editor exited with code ${code}`));
    });
  });
}

async function withReadlineSuspended(rl, fn) {
  if (!rl) {
    return fn();
  }
  const input = rl.input;
  const hadRawMode = Boolean(input?.isTTY && input.isRaw);
  rl.pause();
  if (hadRawMode) {
    input.setRawMode(false);
  }
  try {
    return await fn();
  } finally {
    if (hadRawMode) {
      input.setRawMode(true);
    }
    rl.resume();
  }
}

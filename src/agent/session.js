import { streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

import { executeCodeBlock, formatExecutionFeedback } from '../runtime/quickjs-runner.js';
import { theme } from '../ui/theme.js';

class AgentSession {
  constructor(options) {
    this.options = options;
    this.messages = [
      {
        role: 'system',
        content: options.systemPrompt,
      },
    ];
    const toolOptions = {
      ...options,
      delegateTaskHandler: typeof options.delegateTaskHandler === 'function'
        ? options.delegateTaskHandler
        : null,
    };
    this.tools = {
      runJavascript: createRunJavascriptTool(toolOptions),
    };
  }

  async submit(text) {
    if (!text) {
      return;
    }

    this.messages.push({ role: 'user', content: text });
    return this.loop();
  }

  getLastAssistantMessage() {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const candidate = this.messages[index];
      if (candidate.role === 'assistant') {
        return coerceContentToText(candidate.content).trim();
      }
    }
    return '';
  }

  async loop() {
    let iteration = 0;
    while (iteration < this.options.maxIterations) {
      iteration += 1;
      const { outputText, finishReason } = await this.invokeModel();

      if (!this.options.stream && outputText.trim()) {
        console.log(`\n${theme.label('assistant>')} ${outputText.trim()}\n`);
      }

      if (finishReason === 'tool-calls') {
        continue;
      }

      if (this.options.prompt) {
        return { finishReason, iteration };
      }
      return;
    }

    console.warn(theme.warning('Reached max iteration limit without receiving a plain-text reply.'));
  }

  async invokeModel() {
    const modelOptions = {
      model: openai(this.options.model),
      messages: this.messages,
      tools: this.tools,
      providerOptions: {
        openai: {
          reasoningEffort: this.options.reasoningEffort,
          reasoningSummary: 'auto',
          verbosity: this.options.verbosity,
        },
      },
      maxOutputTokens: this.options.maxOutputTokens,
    };

    const result = streamText(modelOptions);

    let outputText = '';
    if (this.options.stream) {
      const renderer = new AssistantStreamRenderer(process.stdout);
      outputText = await renderer.render(result.fullStream);
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
    return { outputText, finishReason };
  }
}

function logExecution(result, label = 'runJavascript') {
  const labelText = theme.label(`[${label}]`);
  const durationText = theme.muted(`${result.durationMs.toFixed(1)} ms`);
  if (result.success) {
    console.log(`\n${labelText} ${theme.success('OK')} (${durationText})`);
    if (result.formattedValue) {
      console.log(`${theme.success('return>')} ${result.formattedValue}`);
    }
  } else {
    console.log(`\n${labelText} ${theme.error('ERROR')} (${durationText})`);
    console.log(`${theme.error('message>')} ${result.errorMessage}`);
    if (result.errorStack) {
      console.log(theme.muted(result.errorStack));
    }
  }

  if (result.logs.length) {
    console.log(theme.heading('console>'));
    const levelStyles = {
      log: theme.muted,
      info: theme.accent,
      warn: theme.warning,
      error: theme.error,
    };
    result.logs.forEach((log) => {
      const stylize = levelStyles[log.level] ?? theme.muted;
      console.log(`  ${stylize(`[${log.level}]`)} ${log.text}`);
    });
  }
}

class AssistantStreamRenderer {
  constructor(target) {
    this.target = target;
    this.outputText = '';
    this.activeSection = null;
    this.headerPrinted = false;
    this.reasoningLineStart = true;
  }

  async render(stream) {
    for await (const chunk of stream) {
      this.handleChunk(chunk);
    }
    this.closeSection();
    if (this.headerPrinted) {
      this.target.write('\n');
    }
    return this.outputText;
  }

  handleChunk(chunk) {
    switch (chunk.type) {
      case 'reasoning-start':
        this.openSection('Reasoning');
        break;
      case 'reasoning-delta':
        if (chunk.text) {
          this.openSection('Reasoning');
          this.writeReasoningText(chunk.text);
        }
        break;
      case 'reasoning-end':
        if (this.activeSection === 'Reasoning') {
          this.closeSection();
        }
        break;
      case 'text-delta':
        if (chunk.text) {
          this.openSection('Response');
          this.writeResponseText(chunk.text);
          this.outputText += chunk.text;
        }
        break;
      case 'tool-call':
        this.openSection('Tool Call');
        this.writeToolCall(chunk);
        break;
      case 'tool-error':
        this.openSection('Tool Error');
        this.writeToolError(chunk);
        break;
      default:
        break;
    }
  }

  ensureAssistantHeader() {
    if (this.headerPrinted) {
      return;
    }
    this.target.write(`\n${theme.label('assistant>')}\n`);
    this.headerPrinted = true;
  }

  openSection(label) {
    this.ensureAssistantHeader();
    if (this.activeSection === label) {
      return;
    }
    this.closeSection();
    const colorForLabel = label === 'Reasoning' ? theme.heading : theme.accent;
    this.target.write(`\n${colorForLabel(`--- ${label} ---`)}\n`);
    this.activeSection = label;
    if (label === 'Reasoning') {
      this.reasoningLineStart = true;
    }
  }

  closeSection() {
    if (!this.activeSection) {
      return;
    }
    if (this.activeSection === 'Reasoning') {
      this.reasoningLineStart = true;
    }
    this.target.write('\n');
    this.activeSection = null;
  }

  writeReasoningText(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    let formatted = '';
    for (const char of normalized) {
      if (char === '\n') {
        formatted += '\n';
        this.reasoningLineStart = true;
        continue;
      }
      if (this.reasoningLineStart) {
        formatted += '  ';
        this.reasoningLineStart = false;
      }
      formatted += char;
    }
    this.target.write(theme.reasoning(formatted));
  }

  writeResponseText(text) {
    this.target.write(text);
  }

  writeToolCall(chunk) {
    const header = `${theme.label('tool>')} ${theme.accent(chunk.toolName)} ${theme.muted(`#${chunk.toolCallId}`)}`;
    this.target.write(`${header}\n`);
    this.target.write(`\`\`\`js\n${chunk.input.code}\n\`\`\`\n`);
  }

  writeToolError(chunk) {
    const header = `${theme.error('tool error>')} ${theme.accent(chunk.toolName)} ${theme.muted(`#${chunk.toolCallId}`)}`;
    this.target.write(`${header}\n`);
    this.target.write(`${formatJson(chunk)}\n`);
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

function formatJson(value) {
  if (value === undefined) {
    return 'undefined';
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

function createRunJavascriptTool(options) {
  const delegateTaskHandler = typeof options.delegateTaskHandler === 'function'
    ? options.delegateTaskHandler
    : null;
  return tool({
    description: 'Execute JavaScript inside the project workspace using a sandboxed QuickJS runtime.',
    inputSchema: z.object({
      code: z.string().min(1, 'Provide code to execute.'),
      timeoutMs: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      durationMs: z.number(),
      logs: z.array(z.object({ level: z.string(), text: z.string() })),
      formattedValue: z.string().nullable().optional(),
      errorMessage: z.string().optional(),
      errorStack: z.string().nullable().optional(),
      feedback: z.string(),
    }),
    execute: async ({ code, timeoutMs }) => {
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : options.executionTimeoutMs;

      const sandboxOptions = delegateTaskHandler
        ? { delegateTaskHandler }
        : {};
      const result = await executeCodeBlock(code, effectiveTimeout, sandboxOptions);
      logExecution(result);
      const payload = {
        success: result.success,
        durationMs: result.durationMs,
        logs: result.logs,
        formattedValue: result.formattedValue ?? null,
        feedback: formatExecutionFeedback(result),
      };
      if (!result.success) {
        payload.errorMessage = result.errorMessage;
        payload.errorStack = result.errorStack ?? null;
      }
      return payload;
    },
  });
}

export { AgentSession };

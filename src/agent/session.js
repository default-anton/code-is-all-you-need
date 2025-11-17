import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

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
          console.log(`\n${theme.label('assistant>')} ${outputText.trim()}\n`);
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

    console.warn(theme.warning('Reached max iteration limit without receiving a plain-text reply.'));
  }

  async invokeModel() {
    const modelOptions = {
      model: openai(this.options.model),
      messages: this.messages,
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
    const codeBlocks = extractCodeBlocks(outputText);
    return { outputText, finishReason, codeBlocks };
  }
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

function logExecution(result, blockIndex) {
  const label = theme.label(`[code block ${blockIndex}]`);
  const durationText = theme.muted(`${result.durationMs.toFixed(1)} ms`);
  if (result.success) {
    console.log(`\n${label} ${theme.success('OK')} (${durationText})`);
    if (result.formattedValue) {
      console.log(`${theme.success('return>')} ${result.formattedValue}`);
    }
  } else {
    console.log(`\n${label} ${theme.error('ERROR')} (${durationText})`);
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

export { AgentSession };

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { SYSTEM_PROMPT } from './config.js';
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

  const session = new AgentSession({ ...options, systemPrompt: SYSTEM_PROMPT });

  if (options.prompt) {
    await session.submit(options.prompt.trim());
    return;
  }

  await runInteractive(session);
}

async function runInteractive(session) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`${theme.heading('Interactive mode.')} ${theme.muted('Type :exit to quit.')}`);
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

    try {
      await session.submit(trimmed);
    } catch (error) {
      console.error(theme.error('Agent loop failed:'), error);
    }
  }

  await rl.close();
}

function assertApiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in the environment.');
  }
}

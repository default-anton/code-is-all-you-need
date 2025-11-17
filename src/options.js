import {
  DEFAULT_EXEC_TIMEOUT,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MODEL,
} from './config.js';
import { theme } from './ui/theme.js';

function ensurePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
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
        console.warn(theme.warning(`Ignoring positional argument: ${arg}. Use --prompt/-p for single-shot mode.`));
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
  const rows = [
    ['-p, --prompt <text>', 'Run a single-shot prompt and exit when no more code blocks'],
    ['--model <model>', 'Override the OpenAI model ID'],
    ['--max-iterations <n>', 'Cap the agent loop iterations (default 12)'],
    ['--timeout <ms>', 'Per-code-block execution timeout (default 8000)'],
    ['--no-stream', 'Disable token streaming'],
    ['--reasoning <level>', 'Set provider reasoning effort (default medium)'],
    ['--verbosity <level>', 'Set provider verbosity hint (default medium)'],
    ['--temperature <value>', 'Sampling temperature (default 0)'],
    ['--max-output-tokens <n>', 'Upper bound for model tokens (default 1024)'],
    ['-h, --help', 'Show this message'],
  ];

  const flagWidth = rows.reduce((max, [flag]) => Math.max(max, flag.length), 0) + 2;

  console.log(`${theme.heading('Usage:')} ${theme.strong('code-loop [options]')}`);
  console.log();
  console.log(theme.heading('Options:'));
  rows.forEach(([flag, description]) => {
    console.log(`  ${theme.accent(flag.padEnd(flagWidth))}${description}`);
  });
}

export { parseCliArgs, printHelp };

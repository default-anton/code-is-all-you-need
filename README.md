# code-is-all-you-need

A tiny CLI that lets GPT-style models drive a JavaScript sandbox instead of emitting structured tool calls. The loop is powered by the [AI SDK](https://ai-sdk.dev/docs/introduction) so the model streams tokens, decides when to run code, and sees the execution traces as part of the next turn.

## Why

- **Full control flow:** The model can branch, loop, and compose helper calls because it emits raw JavaScript.
- **Simple surface area:** We expose a lightweight SDK (`sdk.*` functions) instead of rigid tool schemas.
- **Deterministic sandbox:** Every code block runs inside a fresh QuickJS context provided by [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten). The WASM module is loaded in-process, so there is no external Wasmtime dependency and nothing persists across executions unless the model writes to disk.
- **Manual agent loop:** We own the entire turn-taking logic (inspired by the AI SDK docs) which lets us bolt on custom logging, safety rails, or termination rules.

## Quick Start

```bash
# 1. Install deps
npm install

# 2. Configure credentials
cp .env.example .env
$EDITOR .env   # set OPENAI_API_KEY

# 3. Launch the CLI (interactive by default)
npm start
```

Interactive mode keeps a running conversation. Type `:exit` or `:q` to bail. The assistant streams tokens, and whenever it sends one or more ```js code fences, each block is executed sequentially in QuickJS. The return value + console output are appended to the next user turn so the agent can keep iterating.

> ℹ️ The QuickJS WebAssembly bundle ships with `quickjs-emscripten`, so `npm install` is all you need. The CLI lazily initializes the runtime the first time a code block needs to execute.

### Single-Shot Mode (`--prompt`/`-p`)

Use the flag when you want to fire a single prompt and stop as soon as the model sends a plain-text answer (i.e., no more code blocks to run):

```bash
code-loop --prompt "Summarize src/cli.js"
```

If the model emits code, the CLI executes it, feeds back the result, and keeps looping until a non-code response arrives. If the very first reply has no code block, the process exits immediately after printing the answer, matching the requirement in the prompt.

## CLI Flags

```
Usage: code-loop [options]

Options:
  -p, --prompt <text>         Run a single-shot prompt and exit when no more code blocks
  --model <model>            Override the OpenAI model ID (default gpt-5.1-codex-mini)
  --max-iterations <n>       Cap the agent loop iterations (default 12)
  --timeout <ms>             Per-code-block execution timeout (default 8000)
  --no-stream                Disable token streaming (falls back to buffered output)
  --reasoning <level>        Hint for OpenAI's reasoning effort (default medium)
  --verbosity <level>        Hint for reasoning verbosity (default medium)
  --temperature <value>      Sampling temperature (default 0)
  --max-output-tokens <n>    Upper bound for model tokens (default 1024)
  -h, --help                 Show this message
```

Environment variables in `.env` (or your shell) can override the same knobs: `CODE_LOOP_MODEL`, `CODE_LOOP_MAX_ITERATIONS`, `CODE_LOOP_TIMEOUT_MS`, etc.

## Manual Agent Loop with the AI SDK

The core of `src/cli.js` is a handcrafted loop over `streamText`. We keep the full conversation history, stream deltas for UX, and detect whether the last assistant turn contained code blocks.

```ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

const result = streamText({
  model: openai(modelId),
  messages,
  providerOptions: {
    openai: {
      reasoningEffort: 'medium',
      verbosity: 'medium',
    },
  },
});

for await (const chunk of result.fullStream) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.text);
  }
}

const responseMessages = (await result.response).messages;
messages.push(...responseMessages);
```

From there we:

1. Parse any ```js fences with a regex.
2. Execute each block in a `vm` sandbox (fresh context, limited globals).
3. Build a structured execution summary and push it back into `messages` as a user turn.
4. Repeat until there are no more code blocks or we hit `--max-iterations`.

This mirrors the "Manual Agent Loop" pattern from the AI SDK documentation but swaps tool calls for JavaScript execution.

## Sandbox Contract & Runtime

Code blocks execute inside QuickJS (via quickjs-emscripten) with host functions wired directly into the VM. Each helper runs in Node.js, resolves a QuickJS promise, and pumps `runtime.executePendingJobs()` so `await` works naturally inside the sandbox. The agent now behaves like a native to-do assistant, so the system prompt only advertises the following helpers:

| Helper | Description |
| --- | --- |
| `sdk.createTodo(input)` | Create a todo `{ title, description?, done?, tags?, dueDate? }` and persist it to `data/todos.json`.
| `sdk.getTodo(id)` | Load a single todo by id (returns `null` when missing).
| `sdk.listTodos()` | Return every stored todo sorted by insertion order.
| `sdk.updateTodo(id, patch)` | Merge partial fields into an existing todo and refresh `updatedAt`.
| `sdk.deleteTodo(id)` | Remove a todo and return `true` when something was deleted.
| `sdk.searchTodos(criteria)` | Filter todos by text/tag/done criteria.

Each todo includes `{ id, title, description, done, tags[], dueDate|null, createdAt, updatedAt }` and lives in `data/todos.json` (directories are created on demand, so the filesystem doubles as our datastore).

For local development we still expose the generic helpers below—they remain available to the sandbox but stay hidden from the agent so it focuses on task management:

| Helper | Description |
| --- | --- |
| `sdk.projectRoot` | Absolute path to the repo root (read-only string).
| `sdk.readFile(path)` | Reads UTF-8 text relative to the project root (uses `fs.promises.readFile`).
| `sdk.writeFile(path, contents)` | Writes UTF-8 text (directories auto-created) and returns a status string.
| `sdk.listFiles(path = '.')` | Lists files/directories for inspection (returns `{ name, kind }[]`).
| `sdk.fetch(url)` | Fetches JSON via Node's native `fetch`, with the CLI enforcing the per-block timeout.

Console calls (`console.log`, `.warn`, `.error`) are captured and echoed back after each execution. The CLI enforces a configurable timeout per block (default 8s) so runaway loops fail fast, and `quickjs-emscripten`'s interrupt handler cuts off busy loops without needing an external process. See the [quickjs-emscripten docs](https://raw.githubusercontent.com/justjake/quickjs-emscripten/refs/heads/main/README.md) for more background on the runtime we embed.

## Project Layout

```
.
├── bin/code-loop.js      # CLI entry point / shebang
├── src/cli.js            # Manual agent loop + sandbox runtime
├── .env.example          # Configuration template
├── package.json / lock   # Dependencies (ai, @ai-sdk/openai, quickjs-emscripten, zod, dotenv)
└── README.md
```

## Development Notes

- Requires Node 20.11+ (for native `fetch`, `readline/promises`, and newer V8 features).
- `npm start` proxies to `node ./bin/code-loop.js`.
- The repo intentionally skips a build step—everything is plain ESM JavaScript.
- If you want to extend the sandbox, add new helpers inside `createSandboxApi` and describe them in the system prompt so the model knows they exist.

Happy hacking!

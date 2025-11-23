# code-is-all-you-need

`code-loop` is a slim CLI that lets LLMs stream thoughts, decide when to execute code, and see the resulting traces on the next turn. Instead of rigid tool schemas the agent gets a single `runJavascript` tool hooked up to a QuickJS sandbox plus a tiny file/system SDK.

## Highlights

- Manual AI SDK loop: `streamText` drives the conversation, with live “Reasoning / Response / Tool” panels in the terminal UI.
- Deterministic QuickJS runtime: every code fence runs inside a fresh context with a 30‑minute default timeout and buffered console capture.
- Workspace-scoped SDK: helpers such as `sdk.readFile`, `writeFile`, `listFiles`, `deletePath`, and `exec` only operate inside `workspace/`, so the agent can inspect or mutate files without escaping the project root.
- Delegation built-in: `sdk.delegateTask` spawns sub-agents that share the same system prompt and SDK but cannot re-delegate, making executor/reviewer loops easy to orchestrate.
- No build step: everything is plain ESM JavaScript and ships with `quickjs-emscripten`, so `npm install` fetches the WASM runtime automatically.

## Setup

```bash
npm install
cp .env.example .env
$EDITOR .env   # set OPENAI_API_KEY=sk-live-...
```

- Node.js ≥ 20.11 is required (native `fetch`, `readline/promises`, AbortController in Node streams).
- Optional overrides live in `.env` (`MAIN_AGENT_MODEL`, `CODE_LOOP_MODEL`, `CODE_LOOP_MAX_ITERATIONS`, `CODE_LOOP_TIMEOUT_MS`, `CODE_LOOP_REASONING`, `CODE_LOOP_VERBOSITY`, `CODE_LOOP_TEMPERATURE`, `CODE_LOOP_MAX_OUTPUT`).

## Run It

Interactive loop (default):

```bash
npm start
```

Single-shot run that exits after the first plain-text answer (handy for scripts or quick checks):

```bash
npm start -- --prompt "Your prompt here"
```

You can also call the binary directly (`node ./bin/code-loop.js ...`) or install it globally to use `code-loop`.

## CLI Knobs

| Flag | Default | Purpose |
| --- | --- | --- |
| `-p, --prompt <text>` | – | Run once, exit after a non-code reply. |
| `--main-model <id>` / `--model` | `gpt-5.1` | Override the primary agent model. |
| `--max-iterations <n>` | `100` | Hard stop for the manual loop (applies to both interactive and prompt mode). |
| `--timeout <ms>` | `1800000` (30 min) | Per code block execution cap. |
| `--no-stream` | streaming on | Disable live reasoning/response output; print buffered text after each turn. |
| `--reasoning <low|medium|high>` | `medium` | Passed through to OpenAI provider options. |
| `--verbosity <low|medium|high>` | `low` | Provider verbosity hint. |
| `--temperature <float>` | `0` | Sampling temperature for both main and delegate agents. |
| `--max-output-tokens <n>` | `1024` | Cap on model tokens per turn. |
| `-h, --help` | – | Print the flag list and exit. |

The same settings respect their `.env` / environment equivalents, so you can keep personal defaults without touching scripts.

## Sandbox & SDK

- **Tool surface:** The agent only has `runJavascript({ code, timeoutMs? })`. Each run spins up a new QuickJS context, evaluates the async IIFE you provide, captures console output, prettifies the return value, and feeds the transcript to the next model turn.
- Every code block starts from a clean VM, so persist anything important via the filesystem (the default workspace is `workspace/` under the repo root).

## Project Layout

- `bin/code-loop.js` – shebang entry; wires CLI args to `src/cli.js`.
- `src/cli.js` – orchestrates interactive vs prompt mode, handles Ctrl‑C, and wires delegate handlers.
- `src/agent/session.js` – manual agent loop, reasoning renderer, `runJavascript` tool wiring.
- `src/runtime/quickjs-runner.js` – QuickJS lifecycle, console shim, deadline enforcement, execution logging.
- `src/workspace-sdk.js` – filesystem and `exec` helpers scoped to `workspace/`.
- `src/options.js` / `src/config.js` – flag parsing plus default resolution.
- `src/prompts.js` – multi-role system prompt generator (main agent vs delegate).
- `src/ui/theme.js` – ANSI color helpers and styling presets.

## Development Notes

- `npm start` proxies to `node ./bin/code-loop.js`; `npm run dev` enables source maps and leaves `NODE_ENV=development`.
- QuickJS lazy-loads on the first execution, so the initial code block will incur a short module load; subsequent runs reuse the same WASM module.
- Extend the SDK by editing `src/runtime/quickjs-runner.js` (for sandbox wiring) and `src/workspace-sdk.js` (for host capabilities), then document the new helper in the system prompt so agents know it exists.

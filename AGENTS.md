`code-loop` is a slim CLI that lets LLMs stream thoughts, decide when to execute code, and see the resulting traces on the next turn. Instead of rigid tool schemas the agent gets a single `runJavascript` tool hooked up to a QuickJS sandbox plus a tiny file/system SDK.

## Highlights

- Deterministic QuickJS runtime: every code fence runs inside a fresh context with a 30‑minute default timeout and buffered console capture.
- Workspace-scoped SDK: helpers such as `sdk.readFile`, `writeFile`, `listFiles`, `deletePath`, and `exec` only operate inside `workspace/`, so the agent can inspect or mutate files without escaping the project root.
- Delegation built-in: `sdk.delegateTask` spawns sub-agents that share the same system prompt and SDK but cannot re-delegate, making executor/reviewer loops easy to orchestrate.
- No build step: everything is plain ESM JavaScript and ships with `quickjs-emscripten`, so `npm install` fetches the WASM runtime automatically.

## Run It

Interactive loop (default):

```bash
npm start
```

Single-shot run that exits after the first plain-text answer (handy for scripts or quick checks):

```bash
npm start -- --prompt "Your prompt here"
```

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

const DEFAULT_MODEL = process.env.CODE_LOOP_MODEL ?? 'gpt-5.1-codex-mini';
const DEFAULT_MAX_ITERATIONS = Number(process.env.CODE_LOOP_MAX_ITERATIONS ?? 100);
const DEFAULT_EXEC_TIMEOUT = Number(process.env.CODE_LOOP_TIMEOUT_MS ?? 1800000); // 30 minutes

export {
  DEFAULT_MODEL,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_EXEC_TIMEOUT,
};

import fs from 'node:fs/promises';
import path from 'node:path';

function createWorkspaceSdk(options = {}) {
  const { workspaceRoot, withDeadline } = options;

  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('createWorkspaceSdk requires a workspaceRoot string.');
  }
  if (typeof withDeadline !== 'function') {
    throw new Error('createWorkspaceSdk requires a withDeadline helper.');
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  let workspaceReady = false;

  function resolveWithinWorkspace(relativePath) {
    const normalizedInput = typeof relativePath === 'string' && relativePath.length
      ? relativePath
      : '.';
    const absolutePath = path.resolve(normalizedRoot, normalizedInput);
    const relative = path.relative(normalizedRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Access outside the workspace directory is prohibited.');
    }
    return absolutePath;
  }

  async function ensureWorkspaceRootExists(deadlineInfo) {
    if (workspaceReady) {
      return;
    }
    await withDeadline(fs.mkdir(normalizedRoot, { recursive: true }), deadlineInfo, 'prepareWorkspace');
    workspaceReady = true;
  }

  function requirePathArgument(value, fnName) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${fnName} requires a non-empty path string.`);
    }
    return value.trim();
  }

  function normalizeOptionalPath(value) {
    if (typeof value !== 'string') {
      return '.';
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : '.';
  }

  function summarizeWrite(relativePath, contents) {
    const text = typeof contents === 'string' ? contents : stringify(contents);
    return { text, length: text.length, relativePath };
  }

  async function readFile(relativePath, deadlineInfo) {
    const pathArg = requirePathArgument(relativePath, 'readFile');
    const absolute = resolveWithinWorkspace(pathArg);
    await ensureWorkspaceRootExists(deadlineInfo);
    return withDeadline(fs.readFile(absolute, 'utf8'), deadlineInfo, 'readFile');
  }

  async function writeFile(relativePath, contents, deadlineInfo) {
    const pathArg = requirePathArgument(relativePath, 'writeFile');
    const absolute = resolveWithinWorkspace(pathArg);
    await ensureWorkspaceRootExists(deadlineInfo);
    const payload = summarizeWrite(pathArg, contents);
    await withDeadline(fs.mkdir(path.dirname(absolute), { recursive: true }), deadlineInfo, 'writeFile');
    await withDeadline(fs.writeFile(absolute, payload.text, 'utf8'), deadlineInfo, 'writeFile');
    return `Wrote ${payload.length} characters to ${pathArg}`;
  }

  async function listFiles(relativePath, deadlineInfo) {
    const pathArg = normalizeOptionalPath(relativePath);
    const absolute = resolveWithinWorkspace(pathArg);
    await ensureWorkspaceRootExists(deadlineInfo);
    const entries = await withDeadline(fs.readdir(absolute, { withFileTypes: true }), deadlineInfo, 'listFiles');
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    }));
  }

  async function deletePath(relativePath, deadlineInfo) {
    const pathArg = requirePathArgument(relativePath, 'deletePath');
    const absolute = resolveWithinWorkspace(pathArg);
    if (absolute === normalizedRoot) {
      throw new Error('deletePath cannot remove the workspace root directory.');
    }
    await ensureWorkspaceRootExists(deadlineInfo);
    let stats;
    try {
      stats = await withDeadline(fs.lstat(absolute), deadlineInfo, 'deletePath');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    if (stats.isDirectory()) {
      await withDeadline(fs.rmdir(absolute), deadlineInfo, 'deletePath');
    } else {
      await withDeadline(fs.unlink(absolute), deadlineInfo, 'deletePath');
    }
    return true;
  }

  return {
    projectRoot: normalizedRoot,
    readFile,
    writeFile,
    listFiles,
    deletePath,
  };
}

function stringify(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

export {
  createWorkspaceSdk,
};

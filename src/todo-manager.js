import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const projectRoot = process.cwd();
const todosDirectory = path.join(projectRoot, 'data');
const todosDbPath = path.join(todosDirectory, 'todos.json');
const TIME_RANGE_FIELDS = new Set(['dueDate', 'createdAt', 'updatedAt']);

export function createTodoManager({ withDeadline }) {
  if (typeof withDeadline !== 'function') {
    throw new Error('createTodoManager requires a withDeadline helper.');
  }

  async function readTodosFromDisk(deadlineInfo) {
    let data;
    try {
      data = await withDeadline(fs.readFile(todosDbPath, 'utf8'), deadlineInfo, 'readTodos');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new Error('Todo database is corrupted.');
    }
  }

  async function writeTodosToDisk(todos, deadlineInfo) {
    await withDeadline(fs.mkdir(todosDirectory, { recursive: true }), deadlineInfo, 'writeTodos');
    const payload = JSON.stringify(todos, null, 2);
    await withDeadline(fs.writeFile(todosDbPath, payload, 'utf8'), deadlineInfo, 'writeTodos');
    return todos;
  }

  function normalizeNewTodoInput(raw) {
    if (raw !== null && typeof raw === 'object') {
      return {
        title: normalizeTitle(raw.title, 'Untitled task'),
        description: typeof raw.description === 'string' ? raw.description : '',
        done: typeof raw.done === 'boolean' ? raw.done : false,
        tags: normalizeTags(raw.tags),
        dueDate: normalizeDueDate(raw.dueDate),
      };
    }

    return {
      title: 'Untitled task',
      description: '',
      done: false,
      tags: [],
      dueDate: null,
    };
  }

  function ensureTodoId(value, fnName) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    throw new Error(`${fnName} requires a non-empty todo id.`);
  }

  function applyTodoPatch(todo, patchInput) {
    const patch = normalizeTodoPatch(patchInput);
    const updatedAt = new Date().toISOString();
    return {
      ...todo,
      ...patch,
      updatedAt,
    };
  }

  function normalizeTodoPatch(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('updateTodo requires a patch object.');
    }

    const patch = {};
    if ('title' in raw) {
      patch.title = normalizeTitle(raw.title);
    }
    if ('description' in raw) {
      patch.description = typeof raw.description === 'string' ? raw.description : '';
    }
    if ('done' in raw) {
      patch.done = Boolean(raw.done);
    }
    if ('tags' in raw) {
      patch.tags = normalizeTags(raw.tags);
    }
    if ('dueDate' in raw) {
      patch.dueDate = normalizeDueDate(raw.dueDate);
    }
    return patch;
  }

  function normalizeTitle(value, fallback) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length) {
        return trimmed;
      }
    }
    if (typeof fallback === 'string' && fallback.length) {
      return fallback;
    }
    throw new Error('Todo title must be a non-empty string.');
  }

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) {
      return [];
    }
    const seen = new Set();
    const normalized = [];
    tags.forEach((tag) => {
      const candidate = typeof tag === 'string' ? tag.trim() : String(tag ?? '').trim();
      if (!candidate) {
        return;
      }
      const lower = candidate.toLowerCase();
      if (seen.has(lower)) {
        return;
      }
      seen.add(lower);
      normalized.push(candidate);
    });
    return normalized;
  }

  function normalizeDueDate(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error('dueDate must be a valid date/time value.');
    }
    return date.toISOString();
  }

  function normalizeSearchCriteria(criteria) {
    if (criteria === undefined || criteria === null) {
      return null;
    }
    if (typeof criteria === 'string') {
      const text = criteria.trim().toLowerCase();
      return text ? { text, tags: [], done: undefined, timeRange: null } : null;
    }
    if (typeof criteria !== 'object') {
      throw new Error('searchTodos expects a string or object criteria.');
    }

    const timeRange = normalizeTimeRange(criteria.timeRange);
    const normalized = {
      text: typeof criteria.text === 'string' ? criteria.text.trim().toLowerCase() :
        (typeof criteria.query === 'string' ? criteria.query.trim().toLowerCase() : ''),
      tags: Array.isArray(criteria.tags) ? normalizeTags(criteria.tags).map((tag) => tag.toLowerCase()) : [],
      done: typeof criteria.done === 'boolean' ? criteria.done : undefined,
      timeRange,
    };

    if (!normalized.text && !normalized.tags.length &&
      typeof normalized.done === 'undefined' && !normalized.timeRange) {
      return null;
    }
    return normalized;
  }

  function todoMatchesCriteria(todo, criteria) {
    if (criteria.text) {
      const haystack = `${todo.title}\n${todo.description}\n${(todo.tags ?? []).join(' ')}`.toLowerCase();
      if (!haystack.includes(criteria.text)) {
        return false;
      }
    }

    if (criteria.tags && criteria.tags.length) {
      const todoTags = (todo.tags ?? []).map((tag) => tag.toLowerCase());
      const hasAllTags = criteria.tags.every((tag) => todoTags.includes(tag));
      if (!hasAllTags) {
        return false;
      }
    }

    if (typeof criteria.done === 'boolean' && todo.done !== criteria.done) {
      return false;
    }

    if (criteria.timeRange) {
      const { field, startMs, endMs } = criteria.timeRange;
      const value = todo[field];
      if (value === null || value === undefined || value === '') {
        return false;
      }
      const timestamp = new Date(value).getTime();
      if (Number.isNaN(timestamp)) {
        return false;
      }
      if (startMs !== null && timestamp < startMs) {
        return false;
      }
      if (endMs !== null && timestamp > endMs) {
        return false;
      }
    }

    return true;
  }

  function normalizeTimeRange(raw) {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'object') {
      throw new Error('timeRange must be an object with optional start/end fields.');
    }

    const field = normalizeTimeRangeField(raw.field);
    const startMs = normalizeTimePoint(raw.start, 'timeRange.start');
    const endMs = normalizeTimePoint(raw.end, 'timeRange.end');

    if (startMs === null && endMs === null) {
      return null;
    }
    if (startMs !== null && endMs !== null && startMs > endMs) {
      throw new Error('timeRange.start must be before or equal to timeRange.end.');
    }

    return { field, startMs, endMs };
  }

  function normalizeTimeRangeField(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return 'dueDate';
    }
    const trimmed = value.trim();
    const mapped = trimmed === 'due' ? 'dueDate'
      : trimmed === 'created' ? 'createdAt'
        : trimmed === 'updated' ? 'updatedAt'
          : trimmed;
    if (!TIME_RANGE_FIELDS.has(mapped)) {
      throw new Error('timeRange.field must be one of dueDate, createdAt, or updatedAt.');
    }
    return mapped;
  }

  function normalizeTimePoint(value, label) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const candidate = value instanceof Date ? value : new Date(value);
    const timestamp = candidate.getTime();
    if (Number.isNaN(timestamp)) {
      throw new Error(`${label} must be a valid date/time value.`);
    }
    return timestamp;
  }

  return {
    async createTodo(payload, deadlineInfo) {
      const todoData = normalizeNewTodoInput(payload);
      const todos = await readTodosFromDisk(deadlineInfo);
      const now = new Date().toISOString();
      const todo = {
        id: randomUUID(),
        ...todoData,
        createdAt: now,
        updatedAt: now,
      };
      todos.push(todo);
      await writeTodosToDisk(todos, deadlineInfo);
      return todo;
    },

    async getTodo(maybeId, deadlineInfo) {
      const id = ensureTodoId(maybeId, 'getTodo');
      const todos = await readTodosFromDisk(deadlineInfo);
      return todos.find((todo) => todo.id === id) ?? null;
    },

    async listTodos(deadlineInfo) {
      return readTodosFromDisk(deadlineInfo);
    },

    async updateTodo(maybeId, patch, deadlineInfo) {
      const id = ensureTodoId(maybeId, 'updateTodo');
      const todos = await readTodosFromDisk(deadlineInfo);
      const index = todos.findIndex((todo) => todo.id === id);
      if (index === -1) {
        throw new Error(`Todo ${id} not found.`);
      }
      const updated = applyTodoPatch(todos[index], patch);
      todos[index] = updated;
      await writeTodosToDisk(todos, deadlineInfo);
      return updated;
    },

    async deleteTodo(maybeId, deadlineInfo) {
      const id = ensureTodoId(maybeId, 'deleteTodo');
      const todos = await readTodosFromDisk(deadlineInfo);
      const index = todos.findIndex((todo) => todo.id === id);
      if (index === -1) {
        return false;
      }
      todos.splice(index, 1);
      await writeTodosToDisk(todos, deadlineInfo);
      return true;
    },

    async searchTodos(criteria, deadlineInfo) {
      const todos = await readTodosFromDisk(deadlineInfo);
      const normalizedCriteria = normalizeSearchCriteria(criteria);
      if (!normalizedCriteria) {
        return todos;
      }
      return todos.filter((todo) => todoMatchesCriteria(todo, normalizedCriteria));
    },
  };
}

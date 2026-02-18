import fs from 'fs/promises';
import path from 'path';
import { appConfig } from './config.js';

const SENSITIVE_KEY_MARKERS = ['password', 'privatekey', 'apikey', 'authorization', 'token', 'secret'];
let cleanedUpDayKey = '';

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function filePathOfDay(day) {
  return path.join(appConfig.logDir, `${day}.jsonl`);
}

function looksSensitiveKey(key) {
  const lowered = String(key || '').toLowerCase();
  return SENSITIVE_KEY_MARKERS.some((marker) => lowered.includes(marker));
}

function sanitizeLogData(input, depth = 0) {
  if (depth > 5) return '[TRUNCATED_DEPTH]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    return input.length > 300 ? `${input.slice(0, 300)}...[TRUNCATED]` : input;
  }

  if (typeof input === 'number' || typeof input === 'boolean') return input;

  if (Array.isArray(input)) {
    const maxItems = 30;
    const mapped = input.slice(0, maxItems).map((item) => sanitizeLogData(item, depth + 1));
    if (input.length > maxItems) mapped.push('[TRUNCATED_ITEMS]');
    return mapped;
  }

  if (typeof input === 'object') {
    const out = {};
    const entries = Object.entries(input);
    const maxKeys = 50;
    for (const [key, value] of entries.slice(0, maxKeys)) {
      if (looksSensitiveKey(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeLogData(value, depth + 1);
      }
    }
    if (entries.length > maxKeys) out.__truncated_keys = true;
    return out;
  }

  return String(input);
}

async function ensureLogDir() {
  await fs.mkdir(appConfig.logDir, { recursive: true });
}

async function cleanupOldLogFiles(now = new Date()) {
  const today = dayKey(now);
  if (cleanedUpDayKey === today) return;
  cleanedUpDayKey = today;

  const retentionDays = clamp(appConfig.logRetentionDays, 7, 3650, 365);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffKey = dayKey(cutoff);

  let files = [];
  try {
    files = await fs.readdir(appConfig.logDir);
  } catch {
    return;
  }

  await Promise.all(
    files
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .filter((name) => name.slice(0, 10) < cutoffKey)
      .map((name) => fs.unlink(path.join(appConfig.logDir, name)).catch(() => undefined))
  );
}

export async function appendLog(entry) {
  const now = new Date();
  const record = {
    ts: now.toISOString(),
    ...sanitizeLogData(entry)
  };

  await ensureLogDir();
  await fs.appendFile(filePathOfDay(dayKey(now)), `${JSON.stringify(record)}\n`, 'utf8');
  await cleanupOldLogFiles(now);
}

function parseDateString(value, fallback, endOfDay = false) {
  if (!value) return fallback;
  const text = String(value);
  const base = endOfDay ? `${text}T23:59:59.999Z` : `${text}T00:00:00.000Z`;
  const date = new Date(base);
  if (Number.isNaN(date.getTime())) return fallback;
  return date;
}

function buildDateKeys(fromDate, toDate) {
  const keys = [];
  let cursor = new Date(fromDate);
  while (cursor <= toDate) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function queryLogs(options = {}) {
  const defaultDays = clamp(appConfig.logQueryDefaultDays, 1, 3650, 30);
  const maxDays = clamp(appConfig.logQueryMaxDays, 1, 3650, 365);
  const maxLimit = clamp(appConfig.logQueryMaxLimit, 10, 50000, 5000);
  const defaultLimit = clamp(appConfig.logQueryDefaultLimit, 10, maxLimit, 500);

  const daysRequested = clamp(Number(options.days), 1, maxDays, defaultDays);
  const limit = clamp(Number(options.limit), 1, maxLimit, defaultLimit);

  const now = new Date();
  let toDate = parseDateString(options.to, now, true);
  let fromDate = parseDateString(options.from, null, false);

  if (!fromDate) {
    fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - (daysRequested - 1));
    fromDate.setHours(0, 0, 0, 0);
  }

  if (fromDate > toDate) {
    const swap = fromDate;
    fromDate = toDate;
    toDate = swap;
  }

  const maxFrom = new Date(toDate);
  maxFrom.setDate(maxFrom.getDate() - (maxDays - 1));
  if (fromDate < maxFrom) fromDate = maxFrom;

  const user = options.user ? String(options.user).toLowerCase() : '';
  const types = Array.isArray(options.types)
    ? new Set(options.types.map((v) => String(v)))
    : null;

  const keys = buildDateKeys(fromDate, toDate).reverse();
  const rows = [];

  for (const key of keys) {
    let text = '';
    try {
      text = await fs.readFile(filePathOfDay(key), 'utf8');
    } catch {
      continue;
    }

    const lines = text.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      const row = parseLine(line);
      if (!row) continue;

      const ts = new Date(row.ts || 0);
      if (Number.isNaN(ts.getTime())) continue;
      if (ts < fromDate || ts > toDate) continue;
      if (user && String(row.user || '').toLowerCase() !== user) continue;
      if (types && !types.has(String(row.type || ''))) continue;

      rows.push(row);
      if (rows.length >= limit) {
        return {
          logs: rows,
          range: {
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            limit,
            days: Math.ceil((toDate - fromDate) / 86400000) + 1,
            maxDays
          }
        };
      }
    }
  }

  return {
    logs: rows,
    range: {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      limit,
      days: Math.ceil((toDate - fromDate) / 86400000) + 1,
      maxDays
    }
  };
}

export { sanitizeLogData };

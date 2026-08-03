/**
 * Shared file-first store utilities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return randomUUID();
}

export function appendJsonLine(logPath: string, record: object): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

export function readJsonLines<T>(logPath: string): T[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  const results: T[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T);
    } catch { /* skip malformed */ }
  }
  return results;
}

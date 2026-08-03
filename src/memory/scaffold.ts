/**
 * Scaffold the durable `.this` memory tree — the built-in source of truth. Idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveMemoryThisDir } from '../config.js';

const THIS_SUBDIRS = [
  'resources/skills',
  'resources/mcps',
  'resources/design-system',
  'resources/docs',
  'user/preferences', 'user/decisions', 'user/constraints', 'user/operations',
  'user/harness', 'user/patterns', 'user/planning', 'user/extractions',
  'agents',
  'journals',
];

/** Create the durable `.this` tree. Idempotent — safe to call on every init. */
export function scaffoldThisMemory(): void {
  const root = resolveMemoryThisDir();
  for (const sub of THIS_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
}

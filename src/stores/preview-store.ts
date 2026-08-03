/**
 * Preview record store — file-first preview deployment tracking.
 * Records stored in `.workbench/previews.jsonl`.
 */

import { resolvePreviewsLog } from '../config.js';
import { appendJsonLine, readJsonLines, uuid, now } from './file-utils.js';

export interface PreviewRecord {
  id: string;
  event: 'create' | 'update' | 'destroy';
  taskId: string;
  workspaceId: string;
  provider: string;
  url: string | null;
  status: string;
  externalId: string;
  timestamp: string;
}

export function readActivePreviews(taskId?: string): PreviewRecord[] {
  const records = readJsonLines<PreviewRecord>(resolvePreviewsLog());
  const byId = new Map<string, PreviewRecord>();

  for (const record of records) {
    if (taskId && record.taskId !== taskId) continue;

    if (record.event === 'destroy') {
      byId.delete(record.id);
    } else {
      byId.set(record.id, record);
    }
  }

  return Array.from(byId.values()).filter(p => p.status !== 'destroyed');
}

export function appendPreviewEvent(
  partial: Omit<PreviewRecord, 'id' | 'timestamp'> & { id?: string },
): void {
  const record: PreviewRecord = {
    id: partial.id ?? uuid(),
    event: partial.event,
    taskId: partial.taskId,
    workspaceId: partial.workspaceId,
    provider: partial.provider,
    url: partial.url,
    status: partial.status,
    externalId: partial.externalId,
    timestamp: now(),
  };
  appendJsonLine(resolvePreviewsLog(), record);
}

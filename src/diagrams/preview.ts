/**
 * Diagram Preview Service — read-only local viewer for managed diagrams.
 *
 * Reuses a running viewer if the configured port already answers a health
 * check; otherwise reserves the port through the shared port-lease
 * reserve operation and starts a detached viewer process that survives
 * the CLI command that spawned it.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
// Shared port-lease allocator, owned by the operations domain
// (operations/LLDs/req-port-lease-allocation-src-port-allocator-ts.md — the
// PortAllocator class in src/port-allocator.ts, append-only .workbench/leases.jsonl,
// reserve-before-grant). Every lease is keyed on a sessionId; the allocator has no
// owner/service concept, so the preview service supplies a fixed session-shaped id.
import { PortAllocator } from '../port-allocator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_ENTRY = path.join(__dirname, 'viewer-server.js');
// Session-shaped id under which the (non-task) preview service reserves its port.
// PortAllocator.reserve() keys leases on sessionId only; using a stable id lets a
// reused/reclaimed lease be recognised across CLI invocations. No release is issued —
// the operations reclaim pass clears the lease if the viewer process dies.
const PREVIEW_SESSION_ID = 'diagrams-preview';
const HEALTH_TIMEOUT_MS = 500;
const START_POLL_MS = 100;
const START_TIMEOUT_MS = 5000;

/** http://localhost:<configured port>/<uuid> */
export function previewUrlFor(uuid: string): string {
  const port = loadConfig().diagrams.previewPort;
  return `http://localhost:${port}/${uuid}`;
}

function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: 'localhost', port, path: '/__health', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(port)) return true;
    await new Promise((r) => setTimeout(r, START_POLL_MS));
  }
  return false;
}

/** Reuse the running viewer, or reserve the port and start one. */
export async function ensurePreviewService(): Promise<void> {
  const config = loadConfig();
  const port = config.diagrams.previewPort;

  if (await probeHealth(port)) return; // already running — reuse it

  const allocator = new PortAllocator(config.ports, config.workspace.id);
  await allocator.reserve(PREVIEW_SESSION_ID, [{ name: 'diagrams-preview', port }]);

  const child = spawn(process.execPath, [VIEWER_ENTRY, String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const healthy = await waitForHealth(port, START_TIMEOUT_MS);
  if (!healthy) {
    throw new Error(
      `Diagram preview service did not become healthy on port ${port} within ${START_TIMEOUT_MS}ms.`,
    );
  }
}

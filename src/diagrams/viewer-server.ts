/**
 * Standalone read-only HTTP server for the diagrams preview service.
 * Run as a detached child process by ensurePreviewService() in preview.ts —
 * never imported directly by the CLI process.
 *
 * Routes:
 *   GET /__health   -> 200 "ok" (used by ensurePreviewService's health probe)
 *   GET /<uuid>     -> 200 application/json, the managed .excalidraw content
 *   anything else   -> 404 / 405
 */
import fs from 'node:fs';
import http from 'node:http';
import { loadDiagramIndex } from './library.js';

const port = Number(process.argv[2]);
if (!port) {
  console.error('viewer-server: missing port argument');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' }).end('Read-only — GET only.');
    return;
  }

  if (url === '/__health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  const uuid = url.replace(/^\//, '');
  const index = loadDiagramIndex();
  const entry = index.diagrams.find((d) => d.uuid === uuid);

  if (!entry || !fs.existsSync(entry.filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Diagram not found.');
    return;
  }

  const content = fs.readFileSync(entry.filePath, 'utf-8');
  res.writeHead(200, { 'content-type': 'application/json' }).end(content);
});

server.listen(port, 'localhost');

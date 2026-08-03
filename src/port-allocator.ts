/**
 * PortAllocator — file-first port lease lifecycle.
 * Append-only log at `.workbench/leases.jsonl` (resolveLeasesLog()). No SQLite, no mutable rows:
 * the set of active leases is derived by replaying the log.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveLeasesLog } from './config.js';
import type { PortAllocatorConfig, PortLease, PortLeaseEvent, PortRequest } from './types.js';

export class PortAllocator {
  constructor(
    private config: PortAllocatorConfig,
    private workspaceId: string,
  ) {}

  /**
   * Reserve one or more named ports for a session.
   * Explicit `port` requests are honored when free; otherwise auto-allocated from `config.range`.
   */
  async reserve(sessionId: string, requests: PortRequest[]): Promise<PortLease[]> {
    const leases: PortLease[] = [];
    for (const req of requests) {
      const protocol = req.protocol ?? 'tcp';
      const port = await this.resolvePort(req, protocol);
      const lease: PortLease = {
        workspaceId: this.workspaceId,
        sessionId,
        name: req.name,
        port,
        protocol,
        reservedAt: new Date().toISOString(),
      };
      this.appendEvent({ ...lease, id: randomUUID(), timestamp: lease.reservedAt, event: 'reserve' });
      leases.push(lease);
    }
    return leases;
  }

  /** Append a release event for every active lease held by `sessionId`. */
  release(sessionId: string): void {
    const now = new Date().toISOString();
    const active = this.readActiveLeases().filter((l) => l.sessionId === sessionId);
    for (const lease of active) {
      this.appendEvent({ ...lease, id: randomUUID(), timestamp: now, event: 'release' });
    }
  }

  /**
   * Scan reserved leases older than `config.staleTtl` seconds; probe each port; append a release
   * event when the port is unreachable (i.e. no external process is actually holding it).
   */
  async reclaim(): Promise<{ released: number; skipped: number }> {
    const cutoffMs = Date.now() - this.config.staleTtl * 1000;
    const active = this.readActiveLeases();
    let released = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    for (const lease of active) {
      if (new Date(lease.reservedAt).getTime() >= cutoffMs) continue; // not stale yet
      const free = await this.probePort(lease.port);
      if (free) {
        this.appendEvent({ ...lease, id: randomUUID(), timestamp: now, event: 'release' });
        released++;
      } else {
        skipped++;
      }
    }
    return { released, skipped };
  }

  /** Current active (reserved, unreleased) leases, optionally filtered. */
  list(filter?: { sessionId?: string; workspaceId?: string }): PortLease[] {
    let leases = this.readActiveLeases();
    if (filter?.sessionId) leases = leases.filter((l) => l.sessionId === filter.sessionId);
    if (filter?.workspaceId) leases = leases.filter((l) => l.workspaceId === filter.workspaceId);
    return leases;
  }

  // ------- Private -------

  private async resolvePort(req: PortRequest, protocol: 'tcp' | 'udp'): Promise<number> {
    if (req.port) {
      const free = await this.isPortFree(req.port, protocol);
      if (free) return req.port;
    }
    return this.autoAllocate(protocol);
  }

  private async isPortFree(port: number, protocol: 'tcp' | 'udp'): Promise<boolean> {
    const active = this.readActiveLeases();
    if (active.some((l) => l.port === port && l.protocol === protocol)) return false;
    return this.probePort(port);
  }

  private async autoAllocate(protocol: 'tcp' | 'udp'): Promise<number> {
    const [rangeStart, rangeEnd] = this.config.range;
    const reserved = new Set(this.config.reserve);
    const active = new Set(
      this.readActiveLeases().filter((l) => l.protocol === protocol).map((l) => l.port),
    );

    const candidates: number[] = [];
    for (let port = rangeStart; port <= rangeEnd; port++) candidates.push(port);
    if (this.config.strategy === 'random') shuffle(candidates);

    for (const port of candidates) {
      if (reserved.has(port) || active.has(port)) continue;
      if (await this.probePort(port)) return port;
    }

    throw new PortAllocationError(
      'PORT_RANGE_EXHAUSTED',
      `All ports in range ${rangeStart}-${rangeEnd} are occupied. Active leases: ${active.size}`,
    );
  }

  /** Attempt to bind the port on 127.0.0.1 — true if free, false if held by another process. */
  private probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
  }

  private readActiveLeases(): PortLease[] {
    const logPath = resolveLeasesLog();
    if (!fs.existsSync(logPath)) return [];

    const byPort = new Map<number, PortLeaseEvent>();
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line) as PortLeaseEvent;
      if (event.event === 'reserve') {
        byPort.set(event.port, event);
      } else {
        byPort.delete(event.port);
      }
    }
    return Array.from(byPort.values()).map((e) => ({
      workspaceId: e.workspaceId,
      sessionId: e.sessionId,
      name: e.name,
      port: e.port,
      protocol: e.protocol,
      reservedAt: e.timestamp,
    }));
  }

  private appendEvent(event: PortLeaseEvent): void {
    const logPath = resolveLeasesLog();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
  }
}

export class PortAllocationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PortAllocationError';
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

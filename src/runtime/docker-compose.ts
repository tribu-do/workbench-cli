/**
 * src/runtime/docker-compose.ts — docker-compose runtime mode support.
 *
 * Pure functions consumed by `workbench init sandboxing`'s docker-compose
 * branch (src/cli/commands/init.ts). Owns compose-file probing/parsing, the
 * dedicated SSH keypair, and the VSCode attach descriptor. Does not provision
 * or start anything — session launch is a later REQ's scope.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRuntimeModeDir } from '../config.js';

const MODE = 'docker-compose' as const;

// ── Host prerequisite probe ─────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Checks that `docker compose` resolves as a subcommand and the daemon responds. */
export function probeDockerCompose(): ProbeResult {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return { ok: false, detail: '`docker compose` subcommand did not resolve.' };
  }
  try {
    execFileSync('docker', ['info'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return { ok: false, detail: 'Docker daemon did not respond to `docker info`.' };
  }
  return { ok: true, detail: 'docker compose resolves and the daemon responded.' };
}

// ── Compose file + service resolution ───────────────────────────────────────────

export class ComposeFileNotFoundError extends Error {
  constructor(public composeFile: string) {
    super(`Compose file not found: ${composeFile}`);
    this.name = 'ComposeFileNotFoundError';
  }
}

export class ComposeServiceNotFoundError extends Error {
  constructor(public service: string, public composeFile: string) {
    super(`Service "${service}" is not declared in ${composeFile}.`);
    this.name = 'ComposeServiceNotFoundError';
  }
}

/** Reject a compose file path that does not exist. */
export function assertComposeFileExists(composeFile: string): void {
  if (!fs.existsSync(composeFile)) {
    throw new ComposeFileNotFoundError(composeFile);
  }
}

/** Read the service names declared in the compose file via `docker compose config --services`. */
export function listComposeServices(composeFile: string): string[] {
  assertComposeFileExists(composeFile);
  const out = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--services'], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Abort with a named error when the selected service is absent from the resolved compose config. */
export function assertServiceExists(service: string, composeFile: string): void {
  const services = listComposeServices(composeFile);
  if (!services.includes(service)) {
    throw new ComposeServiceNotFoundError(service, composeFile);
  }
}

// ── SSH keypair ──────────────────────────────────────────────────────────────────

export interface SshKeypair {
  privateKeyPath: string;
  publicKeyPath: string;
}

/**
 * Generate a dedicated ed25519 SSH keypair for the docker-compose profile under
 * `.workbench/runtimes/docker-compose/`, with owner-only permissions on the
 * private key (0600).
 */
export function generateSshKeypair(profileName: string): SshKeypair {
  const dir = resolveRuntimeModeDir(MODE);
  fs.mkdirSync(dir, { recursive: true });

  const privateKeyPath = path.join(dir, `${profileName}.id_ed25519`);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (fs.existsSync(privateKeyPath)) fs.rmSync(privateKeyPath);
  if (fs.existsSync(publicKeyPath)) fs.rmSync(publicKeyPath);

  execFileSync('ssh-keygen', [
    '-t', 'ed25519',
    '-N', '',
    '-C', `workbench-docker-compose-${profileName}`,
    '-f', privateKeyPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  fs.chmodSync(privateKeyPath, 0o600);
  fs.chmodSync(publicKeyPath, 0o644);

  return { privateKeyPath, publicKeyPath };
}

/** Remove a generated keypair and its profile's local settings file — used when
 *  configuration fails after the keypair was already written. */
export function rollbackKeypair(profileName: string, keypair: SshKeypair): void {
  for (const file of [keypair.privateKeyPath, keypair.publicKeyPath]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  const dir = resolveRuntimeModeDir(MODE);
  const settingsPath = path.join(dir, `${profileName}.yaml`);
  if (fs.existsSync(settingsPath)) fs.rmSync(settingsPath);
}

// ── Settings split (inline vs. local) ───────────────────────────────────────────

export interface DockerComposeAnswers {
  composeFile: string;
  service: string;
  containerWorkspaceFolder: string;
  sshUsername: string;
}

/** Compose file path, service name, and container workspace folder are shareable
 *  — written inline under the named profile in workbench.yaml. */
export function buildInlineSettings(answers: DockerComposeAnswers): Record<string, unknown> {
  return {
    composeFile: answers.composeFile,
    service: answers.service,
    containerWorkspaceFolder: answers.containerWorkspaceFolder,
  };
}

/** SSH keypair paths and username are local settings — written to
 *  `.workbench/runtimes/docker-compose/<profile>.yaml`. */
export function buildLocalSettings(answers: DockerComposeAnswers, keypair: SshKeypair): Record<string, unknown> {
  return {
    sshUsername: answers.sshUsername,
    sshPrivateKeyPath: keypair.privateKeyPath,
    sshPublicKeyPath: keypair.publicKeyPath,
  };
}

// ── VSCode attach descriptor ─────────────────────────────────────────────────────

export interface VsCodeAttachDescriptor {
  service: string;
  containerWorkspaceFolder: string;
  privateKeyPath: string;
}

/** Exposed for the (later) operations connect step to consume. */
export function buildAttachDescriptor(
  answers: DockerComposeAnswers,
  keypair: SshKeypair,
): VsCodeAttachDescriptor {
  return {
    service: answers.service,
    containerWorkspaceFolder: answers.containerWorkspaceFolder,
    privateKeyPath: keypair.privateKeyPath,
  };
}

/** Human-readable connect instructions printed on successful configuration. */
export function connectInstructions(profileName: string, descriptor: VsCodeAttachDescriptor): string {
  return [
    `Connect VSCode to the "${profileName}" docker-compose service ("${descriptor.service}"):`,
    `  1. Add an SSH host entry using private key: ${descriptor.privateKeyPath}`,
    `  2. Remote workspace folder: ${descriptor.containerWorkspaceFolder}`,
    '  3. Use the "Remote - SSH" extension to connect, then "Open Folder" to the path above.',
  ].join('\n');
}

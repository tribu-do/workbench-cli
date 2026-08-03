/**
 * Task Wizard — Interactive LLD-first task creation.
 *
 * Workflow:
 *   1. Select LLD document file (.md in project root or configured dir)
 *   2. Select AI agent (grouped by configured vs not-configured)
 *   3. Select runtime mode (aio-sandbox, openshell, devcontainer, docker)
 *   4. Configure auto-approve, ports, preview
 *   5. Create task and optionally launch agent
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import type { WorkbenchContext } from '../context.js';
import type { TaskSpec, RuntimeMode } from '../../types.js';
import { listAvailableBackends, type SandboxBackend } from '../../runtime/backends.js';

interface WizardAnswers {
  lldFile?: string;
  agent: 'claude' | 'codex' | 'copilot';
  runtimeMode: RuntimeMode;
  sandboxBackend: SandboxBackend;
  autoApprove: boolean;
  port?: number;
  preview?: 'coolify' | 'netlify' | 'cloudflare' | 'none';
  name?: string;
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultValue ? ` [${defaultValue}]` : '';

  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function promptChoice<T extends string>(
  question: string,
  choices: Array<{ value: T; label: string; configured?: boolean }>,
  defaultValue?: T,
): Promise<T> {
  console.log(`\n${question}`);

  // Group by configured status
  const configured = choices.filter((c) => c.configured !== false);
  const notConfigured = choices.filter((c) => c.configured === false);

  let idx = 1;
  const indexMap: Record<number, T> = {};

  if (configured.length > 0) {
    console.log('  Configured:');
    for (const c of configured) {
      const marker = c.value === defaultValue ? ' (default)' : '';
      console.log(`    ${idx}) ${c.label}${marker}`);
      indexMap[idx] = c.value;
      idx++;
    }
  }

  if (notConfigured.length > 0) {
    console.log('  Not configured:');
    for (const c of notConfigured) {
      console.log(`    ${idx}) ${c.label}`);
      indexMap[idx] = c.value;
      idx++;
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Selection [1]: ', (answer) => {
      rl.close();
      const num = parseInt(answer, 10);
      if (num > 0 && indexMap[num]) {
        resolve(indexMap[num]);
      } else {
        resolve(defaultValue ?? indexMap[1]);
      }
    });
  });
}

async function promptConfirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

/**
 * Find LLD/design document files in the project.
 */
async function findLLDFiles(baseDir: string): Promise<string[]> {
  // Look for markdown files that might be LLDs
  const patterns = [
    '*.md',
    'docs/*.md',
    'design/*.md',
    'llm/*.md',
    'lld/*.md',
    'specs/*.md',
  ];

  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: baseDir, nodir: true });
    files.push(...matches);
  }

  // Filter out common non-LLD files
  const exclude = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE.md', 'CODE_OF_CONDUCT.md'];
  return files.filter((f) => !exclude.includes(path.basename(f)));
}

/**
 * Check which agents are configured (have credentials).
 */
function getAgentStatus(): Array<{ value: 'claude' | 'codex' | 'copilot'; label: string; configured: boolean }> {
  return [
    {
      value: 'claude',
      label: 'Claude (Anthropic)',
      configured: !!process.env.ANTHROPIC_API_KEY,
    },
    {
      value: 'codex',
      label: 'Codex (OpenAI)',
      configured: !!process.env.OPENAI_API_KEY,
    },
    {
      value: 'copilot',
      label: 'Copilot (GitHub)',
      configured: !!process.env.GITHUB_TOKEN,
    },
  ];
}

/**
 * Get available runtime backends with availability status.
 */
function getRuntimeChoices(): Array<{ value: SandboxBackend; label: string; configured: boolean }> {
  const backends = listAvailableBackends();

  return [
    {
      value: 'aio-sandbox',
      label: 'AIO Sandbox (Browser, Shell, VSCode)',
      configured: backends.find((b) => b.name === 'aio-sandbox')?.available ?? false,
    },
    {
      value: 'devcontainer',
      label: 'Devcontainer (VS Code spec)',
      configured: backends.find((b) => b.name === 'devcontainer')?.available ?? false,
    },
    {
      value: 'docker',
      label: 'Docker (basic container)',
      configured: backends.find((b) => b.name === 'docker')?.available ?? false,
    },
  ];
}

/**
 * Run the interactive task wizard.
 */
export async function runTaskWizard(wb: WorkbenchContext): Promise<TaskSpec | null> {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     Workbench Task Creation Wizard         ║');
  console.log('╚════════════════════════════════════════════╝');

  const answers: Partial<WizardAnswers> = {};

  // Step 1: LLD file selection
  console.log('\n─── Step 1: Task Document ───');
  const lldFiles = await findLLDFiles(process.cwd());

  if (lldFiles.length > 0) {
    console.log('\nFound document files:');
    lldFiles.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
    console.log(`  ${lldFiles.length + 1}) None / enter manually`);

    const selection = await prompt('Select document', '1');
    const idx = parseInt(selection, 10) - 1;

    if (idx >= 0 && idx < lldFiles.length) {
      answers.lldFile = lldFiles[idx];
      console.log(`Selected: ${answers.lldFile}`);
    }
  } else {
    console.log('No document files found in project.');
    const manual = await prompt('Enter document path (or leave blank)');
    if (manual && fs.existsSync(manual)) {
      answers.lldFile = manual;
    }
  }

  // Step 2: Agent selection
  console.log('\n─── Step 2: AI Agent ───');
  const agents = getAgentStatus();
  const defaultAgent = agents.find((a) => a.configured)?.value ?? 'claude';

  answers.agent = await promptChoice(
    'Select AI agent:',
    agents,
    defaultAgent,
  );

  if (!agents.find((a) => a.value === answers.agent)?.configured) {
    console.log(`\nWarning: ${answers.agent} is not configured.`);
    console.log('Run `workbench init agent` to configure credentials.');
    const proceed = await promptConfirm('Continue anyway?', false);
    if (!proceed) {
      console.log('Wizard cancelled.');
      return null;
    }
  }

  // Step 3: Runtime mode selection
  console.log('\n─── Step 3: Runtime Mode ───');
  const runtimes = getRuntimeChoices();
  const defaultRuntime = runtimes.find((r) => r.configured)?.value ?? 'docker';

  answers.sandboxBackend = await promptChoice(
    'Select runtime:',
    runtimes,
    defaultRuntime,
  );

  // Map sandbox backend to runtime mode
  answers.runtimeMode = answers.sandboxBackend === 'docker' ? 'daemon-managed' : 'daemon-managed';

  // Step 4: Auto-approve
  console.log('\n─── Step 4: Automation ───');
  answers.autoApprove = await promptConfirm('Enable auto-approve for tool calls?', true);

  // Step 5: Port allocation
  const usePort = await promptConfirm('Allocate a port?', true);
  if (usePort) {
    const portInput = await prompt('Port number (auto = next available)', 'auto');
    if (portInput !== 'auto') {
      answers.port = parseInt(portInput, 10);
    }
  }

  // Step 6: Preview deployment
  console.log('\n─── Step 5: Preview Deployment ───');
  const previewChoices = [
    { value: 'none' as const, label: 'No preview', configured: true },
    { value: 'coolify' as const, label: 'Coolify', configured: !!process.env.WORKBENCH_COOLIFY_TOKEN },
    { value: 'netlify' as const, label: 'Netlify', configured: !!process.env.WORKBENCH_NETLIFY_TOKEN },
    { value: 'cloudflare' as const, label: 'Cloudflare', configured: !!process.env.WORKBENCH_CLOUDFLARE_API_TOKEN },
  ];

  answers.preview = await promptChoice(
    'Select preview provider:',
    previewChoices,
    'none',
  );

  // Step 7: Task name
  console.log('\n─── Step 6: Task Name ───');
  const defaultName = answers.lldFile
    ? path.basename(answers.lldFile, '.md').replace(/[^a-zA-Z0-9-]/g, '-')
    : `task-${Date.now().toString(36)}`;

  answers.name = await prompt('Task name', defaultName);

  // Summary
  console.log('\n─── Summary ───');
  console.log(`  Name:        ${answers.name}`);
  console.log(`  Document:    ${answers.lldFile ?? 'none'}`);
  console.log(`  Agent:       ${answers.agent}`);
  console.log(`  Runtime:     ${answers.sandboxBackend}`);
  console.log(`  Auto-approve: ${answers.autoApprove}`);
  console.log(`  Port:        ${answers.port ?? 'auto'}`);
  console.log(`  Preview:     ${answers.preview}`);

  const confirm = await promptConfirm('\nCreate task?', true);
  if (!confirm) {
    console.log('Wizard cancelled.');
    return null;
  }

  // Build task spec
  const spec: TaskSpec = {
    name: answers.name!,
    aiAgentProvider: answers.agent,
    runtimeMode: answers.runtimeMode,
    autoApprove: answers.autoApprove,
    ports: answers.port ? [answers.port] : undefined,
    deployProvider: answers.preview !== 'none' ? answers.preview : undefined,
    metadata: {
      lldFile: answers.lldFile,
      sandboxBackend: answers.sandboxBackend,
      createdVia: 'wizard',
    },
  };

  return spec;
}

/**
 * Read LLD file content for initial prompt.
 */
export function readLLDContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

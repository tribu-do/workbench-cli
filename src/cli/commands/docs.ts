/**
 * CLI: workbench docs — Documentation index management and search.
 *
 * Wraps @arabold/docs-mcp-server CLI with the Workbench data directory
 * (.workbench/memory/docs/indexed) and optionally feeds search results
 * into OpenViking as reference memories.
 *
 * Commands:
 *   docs scrape <lib> <url>   Index documentation from a URL
 *   docs search <lib> <query> Search indexed docs (+ optional --feed flag)
 *   docs fetch <url>          Fetch a single URL as Markdown (no indexing)
 *   docs list                 List all indexed libraries
 *   docs remove <lib>         Remove a library from the index
 *   docs refresh <lib>        Re-scrape an indexed library (ETag-aware)
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { resolveDocsMcpDataDir, resolveOpenVikingWorkspace, loadGlobalConfig } from '../../config.js';
import { resolveMemoryPlugin } from '../../memory/registry.js';
import { FilesystemPlugin } from '../../memory/adapters/filesystem.js';
import * as ui from '../ui.js';

const DOCS_SERVER = '@arabold/docs-mcp-server@latest';

function docsMcpEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCS_MCP_STORE_PATH: resolveDocsMcpDataDir(),
  };
}

/** Env for the unified/standalone server processes — data dir + configured embedding model. */
function docsServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOCS_MCP_STORE_PATH: resolveDocsMcpDataDir(),
  };
  const global = loadGlobalConfig();
  if (global.docs?.embedding_model) env.DOCS_MCP_EMBEDDING_MODEL = global.docs.embedding_model;
  if (global.docs?.api_base) env.OPENAI_API_BASE = global.docs.api_base;
  return env;
}

function runDocsMcp(args: string[], opts?: { silent?: boolean }): string {
  try {
    const out = execFileSync('npx', [DOCS_SERVER, ...args], {
      env: docsMcpEnv(),
      stdio: opts?.silent ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return out.toString().trim();
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(e.stderr?.toString().trim() || e.message);
  }
}

function isDocsMcpAvailable(): boolean {
  try {
    execSync(`npx --yes ${DOCS_SERVER} --version`, {
      env: docsMcpEnv(),
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe whether a docs service (unified server or standalone web) already answers on host:port. */
async function isDocsServiceRunning(host: string, port: string | number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export interface IndexedLibrary {
  name: string;
  versions: Array<{ version: string; documentCount: number; indexedAt: string; status: string }>;
}

/** Shared data source for `docs list` and `docs status` — the single place that shells out. */
export function listIndexedLibraries(): IndexedLibrary[] {
  const out = runDocsMcp(['list', '--output', 'json'], { silent: true });
  try {
    return JSON.parse(out) as IndexedLibrary[];
  } catch {
    return [];
  }
}

/** Dedicated embedding-model reporting function — reads workbench's own persisted setting. */
function reportEmbeddingModel(): string {
  const global = loadGlobalConfig();
  if (!global.docs?.embedding_model) return 'default (docs-mcp-server built-in default; run `workbench init docs` to configure)';
  return `${global.docs.embedding_model}${global.docs.api_base ? ` @ ${global.docs.api_base}` : ''} (preset: ${global.docs.preset})`;
}

/**
 * Feed docs results into memory: always into the built-in `.this` filestorage (default target),
 * and additionally into an activated memory plugin (e.g. OpenViking) when one is configured.
 */
async function feedDocsToMemory(
  library: string,
  query: string,
  results: DocSearchResult[],
): Promise<void> {
  const builtin = new FilesystemPlugin();
  const active = await resolveMemoryPlugin();

  for (const r of results) {
    const record = {
      kind: 'event' as const,
      body: `# ${r.title ?? r.url}\n\nSource: ${r.url}\nLibrary: ${library}\nQuery: ${query}\n\n${r.content}`,
      grounding: [{ type: 'tool-output' as const, uri: r.url }],
    };
    const meta = { tags: [library, 'docs-feed'] };

    await builtin.put({ scope: 'project', id: 'docs' }, record, meta);
    if (active.name !== builtin.name) {
      await active.put({ scope: 'project', id: 'docs' }, record, meta);
    }
  }
}

interface DocSearchResult {
  url: string;
  title?: string;
  content: string;
  score?: number;
}

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description('Documentation index management and search');

  // ── list ──────────────────────────────────────────────────────────────────
  docs
    .command('list')
    .description('List all indexed libraries and versions')
    .action(() => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available. Run: npx @arabold/docs-mcp-server@latest');
        process.exit(1);
      }
      const libraries = listIndexedLibraries();
      if (libraries.length === 0) {
        ui.log.info('No libraries indexed yet. Run: workbench docs scrape <name> <url>');
        return;
      }
      ui.note(
        libraries.flatMap((lib) => lib.versions.map((v) => {
          const label = v.version ? `${lib.name}@${v.version}` : lib.name;
          const age = new Date(v.indexedAt).toLocaleDateString();
          return `${label.padEnd(32)} ${String(v.documentCount).padStart(4)} docs  ${v.status.padEnd(12)} ${age}`;
        })).join('\n'),
        `Indexed libraries (${libraries.length})`,
      );
    });

  // ── server ───────────────────────────────────────────────────────────────
  docs
    .command('server')
    .description('Start the docs MCP server in unified mode (MCP + SSE + web dashboard)')
    .option('-p, --port <port>', 'Port to bind', '6280')
    .option('-h, --host <host>', 'Host to bind', '0.0.0.0')
    .action((opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available. Run: npx @arabold/docs-mcp-server@latest');
        process.exit(1);
      }

      ui.intro('Docs MCP server (unified mode)');
      const base = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`;
      ui.note(
        [`MCP endpoint:   ${base}/mcp`, `SSE endpoint:   ${base}/sse`, `Dashboard:      ${base}/`].join('\n'),
        'Docs server starting',
      );

      spawnSync('npx', [DOCS_SERVER, 'server', '--protocol', 'http', '--port', opts.port, '--host', opts.host], {
        env: docsServerEnv(),
        stdio: 'inherit',
      });
    });

  // ── web ──────────────────────────────────────────────────────────────────
  docs
    .command('web')
    .description('Start the standalone docs web dashboard (no-op if a docs service is already running)')
    .option('-p, --port <port>', 'Port to bind', '6280')
    .option('-h, --host <host>', 'Host to bind', '0.0.0.0')
    .action(async (opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available. Run: npx @arabold/docs-mcp-server@latest');
        process.exit(1);
      }

      const displayHost = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
      const dashboardUrl = `http://${displayHost}:${opts.port}/`;

      if (await isDocsServiceRunning(displayHost, opts.port)) {
        ui.log.info(`A docs service is already running. Dashboard: ${dashboardUrl}`);
        return;
      }

      ui.intro('Docs web dashboard');
      ui.note(`Dashboard: ${dashboardUrl}`, 'Docs web starting');

      spawnSync('npx', [DOCS_SERVER, 'web', '--port', opts.port, '--host', opts.host], {
        env: docsServerEnv(),
        stdio: 'inherit',
      });
    });

  // ── status ───────────────────────────────────────────────────────────────
  docs
    .command('status')
    .description('Report indexed libraries and the active embedding model')
    .action(() => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available. Run: npx @arabold/docs-mcp-server@latest');
        process.exit(1);
      }

      const libraries = listIndexedLibraries();
      ui.note(
        libraries.length === 0
          ? 'No libraries indexed yet.'
          : libraries.flatMap((lib) => lib.versions.map((v) => {
              const label = v.version ? `${lib.name}@${v.version}` : lib.name;
              return `${label.padEnd(32)} ${String(v.documentCount).padStart(4)} docs`;
            })).join('\n'),
        `Indexed libraries (${libraries.length})`,
      );
      ui.log.info(`Embedding model: ${reportEmbeddingModel()}`);
    });

  // ── scrape ────────────────────────────────────────────────────────────────
  docs
    .command('scrape <library> <url>')
    .description('Index documentation from a URL into the local store')
    .option('-v, --version <ver>', 'Version label for the indexed docs')
    .option('-p, --max-pages <n>', 'Maximum pages to scrape', '100')
    .option('-d, --max-depth <n>', 'Maximum crawl depth', '4')
    .option('--no-clean', 'Append to existing index instead of replacing')
    .action(async (library, url, opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available.');
        process.exit(1);
      }

      const args = ['scrape', library, url,
        '--scrape-mode', 'fetch',
        '--max-pages', opts.maxPages,
        '--max-depth', opts.maxDepth,
      ];
      if (opts.version) args.push('--version', opts.version);
      if (!opts.clean) args.push('--no-clean');

      try {
        const out = await ui.spin(`Indexing ${library} from ${url}`, async () => runDocsMcp(args));
        ui.log.success(out || `Done — ${library} indexed.`);
        ui.log.info(`Data dir: ${resolveDocsMcpDataDir()}`);
      } catch (err) {
        ui.log.error(`Scrape failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── search ────────────────────────────────────────────────────────────────
  docs
    .command('search <library> [query]')
    .description('Search indexed docs (use --feed to store results in OpenViking)')
    .option('-v, --version <ver>', 'Version constraint (e.g. 18.x)')
    .option('-l, --limit <n>', 'Max results', '5')
    .option('--feed', 'Feed results into OpenViking as reference memories')
    .action(async (library, query, opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available.');
        process.exit(1);
      }

      let q = query as string | undefined;
      if (!q) {
        if (ui.mode() === 'non_interactive') {
          ui.log.error('Missing search query. Pass it as an argument in non-interactive mode.');
          process.exit(1);
        }
        q = await ui.text({ message: `Search ${library} for`, placeholder: 'e.g. useEffect cleanup' });
      }

      const args = ['search', library, q, '--limit', opts.limit, '--output', 'json', '--quiet'];
      if (opts.version) args.push('--version', opts.version);

      try {
        const raw = await ui.spin(`Searching ${library}`, async () => runDocsMcp(args, { silent: true }));
        const results = JSON.parse(raw) as DocSearchResult[];

        if (results.length === 0) {
          ui.log.info(`No results for "${q}" in ${library}.`);
          return;
        }

        for (const r of results) {
          ui.note(
            `${r.url}\n${r.score != null ? `score ${r.score.toFixed(3)}\n` : ''}\n${r.content.slice(0, 500)}${r.content.length > 500 ? '\n[...]' : ''}`,
            r.title ?? r.url,
          );
        }

        if (opts.feed) {
          await ui.spin('Feeding results into memory', async () => feedDocsToMemory(library, q!, results));
        }
      } catch (err) {
        ui.log.error(`Search failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── fetch ─────────────────────────────────────────────────────────────────
  docs
    .command('fetch <url>')
    .description('Fetch a single URL as Markdown (does not index)')
    .option('--feed <library>', 'Feed fetched content into OpenViking under this library name')
    .action(async (url, opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available.');
        process.exit(1);
      }

      try {
        const content = await ui.spin(`Fetching ${url}`, async () => runDocsMcp(['fetch-url', url, '--quiet'], { silent: true }));
        ui.note(content, url);

        if (opts.feed) {
          await feedDocsToMemory(opts.feed, url, [{ url, content }]);
          ui.log.success(`Fed into memory: .this/user/docs/${opts.feed}`);
        }
      } catch (err) {
        ui.log.error(`Fetch failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── refresh ───────────────────────────────────────────────────────────────
  docs
    .command('refresh <library>')
    .description('Re-scrape an indexed library (skips unchanged pages via ETag)')
    .option('-v, --version <ver>', 'Version to refresh')
    .action(async (library, opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available.');
        process.exit(1);
      }
      const args = ['refresh', library];
      if (opts.version) args.push('--version', opts.version);

      try {
        const out = await ui.spin(`Refreshing ${library}`, async () => runDocsMcp(args));
        ui.log.success(out || `Done — ${library} refreshed.`);
      } catch (err) {
        ui.log.error(`Refresh failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ── remove ────────────────────────────────────────────────────────────────
  docs
    .command('remove <library>')
    .description('Remove a library from the index')
    .option('-v, --version <ver>', 'Specific version to remove')
    .action(async (library, opts) => {
      if (!isDocsMcpAvailable()) {
        ui.log.error('docs-mcp-server not available.');
        process.exit(1);
      }
      const args = ['remove', library];
      if (opts.version) args.push('--version', opts.version);

      try {
        const out = await ui.spin(`Removing ${library}`, async () => runDocsMcp(args));
        ui.log.success(out || `Removed ${library} from index.`);
      } catch (err) {
        ui.log.error(`Remove failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

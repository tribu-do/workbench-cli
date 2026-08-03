/**
 * diagram.create — native agent-callable tool contract.
 *
 * Primary creation surface for Workbench diagrams. Generates a drawing from
 * a natural-language prompt via a plugin, then persists + registers it as a
 * managed artifact in one operation. `workbench diagrams create` (CLI) is a
 * thin wrapper over this function — see
 * src/cli/commands/diagrams.ts.
 */

import {
  createManagedDiagram,
  DiagramIndexError,
  DiagramPersistError,
  DiagramRegisterError,
  type DiagramEntry,
} from './library.js';
import { excalidrawPlugin } from './plugins/excalidraw.js';
import type { DiagramPlugin } from './plugins/types.js';

export type DiagramPluginName = 'excalidraw';

const PLUGINS: Record<DiagramPluginName, DiagramPlugin> = {
  excalidraw: excalidrawPlugin,
};

/** True when `name` is a registered plugin — narrows an arbitrary string to DiagramPluginName. */
function isDiagramPluginName(name: string): name is DiagramPluginName {
  return Object.prototype.hasOwnProperty.call(PLUGINS, name);
}

export interface DiagramCreateInput {
  /** Required natural-language description of the diagram to produce. */
  prompt: string;
  /** Plugin name; defaults to 'excalidraw'. Validated against the registered plugins. */
  plugin?: string;
  /** Overrides the auto-generated slug. */
  slug?: string;
  /** Return uuid + full artifact details instead of just the file path. */
  verbose?: boolean;
}

export type DiagramCreateErrorCode =
  | 'required_argument_missing'
  | 'drawing_could_not_be_generated'
  | 'artifact_persist_failed'
  | 'artifact_register_failed'
  | 'index_write_failed';

export type DiagramCreateResult =
  | {
      ok: true;
      filePath: string;
      uuid?: string;
      plugin: DiagramPluginName;
      createdAt?: string;
      updatedAt?: string;
    }
  | { ok: false; error: DiagramCreateErrorCode; reason: string };

export async function diagramCreate(input: DiagramCreateInput): Promise<DiagramCreateResult> {
  if (!input.prompt || !input.prompt.trim()) {
    return {
      ok: false,
      error: 'required_argument_missing',
      reason: 'diagram.create requires a non-empty "prompt".',
    };
  }

  const pluginName = input.plugin ?? 'excalidraw';
  if (!isDiagramPluginName(pluginName)) {
    return {
      ok: false,
      error: 'drawing_could_not_be_generated',
      reason: `Unknown plugin "${pluginName}". Available: ${Object.keys(PLUGINS).join(', ')}.`,
    };
  }
  const plugin = PLUGINS[pluginName];

  let scene: Record<string, unknown>;
  try {
    scene = await plugin.generate(input.prompt);
  } catch (err) {
    return {
      ok: false,
      error: 'drawing_could_not_be_generated',
      reason: `${pluginName} plugin failed to produce a drawing: ${(err as Error).message}`,
    };
  }

  let content: string;
  try {
    content = JSON.stringify(scene, null, 2);
  } catch (err) {
    return {
      ok: false,
      error: 'drawing_could_not_be_generated',
      reason: `${pluginName} plugin returned a scene that could not be serialized: ${(err as Error).message}`,
    };
  }

  let entry: DiagramEntry;
  try {
    entry = createManagedDiagram(content, { slugSource: input.prompt, slugOverride: input.slug });
  } catch (err) {
    if (err instanceof DiagramIndexError) {
      return { ok: false, error: 'index_write_failed', reason: err.message };
    }
    if (err instanceof DiagramRegisterError) {
      return { ok: false, error: 'artifact_register_failed', reason: err.message };
    }
    if (err instanceof DiagramPersistError) {
      return { ok: false, error: 'artifact_persist_failed', reason: err.message };
    }
    return { ok: false, error: 'artifact_persist_failed', reason: (err as Error).message };
  }

  if (input.verbose) {
    return {
      ok: true,
      filePath: entry.filePath,
      uuid: entry.uuid,
      plugin: pluginName,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }
  return { ok: true, filePath: entry.filePath, plugin: pluginName };
}

/**
 * Default diagram.create plugin — Excalidraw.
 *
 * v1 scope: this plugin does not perform natural-language → layout
 * synthesis — no rendering engine or model call is specified by the Diagram
 * Create Tool REQ. It produces a minimal, valid Excalidraw scene containing
 * the prompt as a single text element so the create → persist → register
 * path is fully exercised end to end. Swap this generate() body for a real
 * NL→diagram generator without changing the plugin interface or any caller.
 */
import crypto from 'node:crypto';
import type { DiagramPlugin } from './types.js';

export const excalidrawPlugin: DiagramPlugin = {
  name: 'excalidraw',
  async generate(prompt: string): Promise<Record<string, unknown>> {
    if (!prompt.trim()) {
      throw new Error('empty prompt');
    }
    return {
      type: 'excalidraw',
      version: 2,
      source: 'workbench',
      elements: [
        {
          id: crypto.randomUUID(),
          type: 'text',
          x: 40,
          y: 40,
          width: 400,
          height: 25,
          text: prompt,
          fontSize: 16,
          fontFamily: 1,
        },
      ],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
  },
};

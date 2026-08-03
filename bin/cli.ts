#!/usr/bin/env node

/**
 * Workbench CLI — AI-first sandboxed agentic development.
 *
 * @license MIT
 * @author Richard Blondet, Claude (Anthropic), Codex (OpenAI)
 */

import { createProgram } from '../src/cli/index.js';

const program = createProgram();
program.parse();

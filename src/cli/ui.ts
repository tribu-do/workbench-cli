/**
 * src/cli/ui.ts — Workbench CLI UX layer over @clack/prompts.
 *
 * Dual-mode:
 *   interactive     — human at a TTY; full @clack prompts, spinners, colors.
 *   non_interactive — agent / pipe / --no-interactive; prompts resolve to a
 *                     provided default or throw NonInteractiveError so callers
 *                     fail fast instead of hanging on stdin.
 */

import {
  intro as clackIntro,
  outro as clackOutro,
  text as clackText,
  password as clackPassword,
  confirm as clackConfirm,
  select as clackSelect,
  multiselect as clackMultiselect,
  group as clackGroup,
  note as clackNote,
  spinner as clackSpinner,
  log as clackLog,
  isCancel,
  cancel as clackCancel,
  type Option as ClackOption,
  type PromptGroup,
} from '@clack/prompts';
import pc from 'picocolors';

// ── Banner ──────────────────────────────────────────────────────────────────

export const BANNER = `
 __        __         _    _                     _
 \\ \\      / /__  _ __| | _| |__   ___ _ __   ___| |__
  \\ \\ /\\ / / _ \\| '__| |/ / '_ \\ / _ \\ '_ \\ / __| '_ \\
   \\ V  V / (_) | |  |   <| |_) |  __/ | | | (__| | | |
    \\_/\\_/ \\___/|_|  |_|\\_\\_.__/ \\___|_| |_|\\___|_| |_|
`;

/** Light-blue tint used for the banner and primary accents. */
export const lightBlue = (s: string): string => pc.cyanBright(s);

// ── Mode detection ────────────────────────────────────────────────────────────

export type Mode = 'interactive' | 'non_interactive';

let forcedNonInteractive = false;

/** Set by the program-level `--no-interactive` flag (see index.ts). */
export function setNonInteractive(value: boolean): void {
  forcedNonInteractive = value;
}

export function mode(): Mode {
  if (forcedNonInteractive) return 'non_interactive';
  if (process.env.WORKBENCH_NO_INTERACTIVE === '1') return 'non_interactive';
  return process.stdout.isTTY && process.stdin.isTTY
    ? 'interactive'
    : 'non_interactive';
}

/** Thrown when a required prompt cannot be answered without a human. */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

/** Exit cleanly if the user pressed Ctrl-C inside a @clack prompt. */
function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) {
    clackCancel('Cancelled.');
    process.exit(130);
  }
  return value as T;
}

// ── Intro / Outro ─────────────────────────────────────────────────────────────

export function intro(description = 'AI-first sandboxed agentic development.'): void {
  if (mode() === 'non_interactive') {
    console.log(BANNER);
    console.log(description);
    return;
  }
  console.log(lightBlue(BANNER));
  clackIntro(pc.dim(description));
}

export function outro(message: string, nextSteps?: string): void {
  if (mode() === 'non_interactive') {
    console.log(message);
    if (nextSteps) console.log(nextSteps);
    return;
  }
  if (nextSteps) clackNote(nextSteps, 'Next steps');
  clackOutro(message);
}

// ── Spinner ────────────────────────────────────────────────────────────────────

export async function spin<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (mode() === 'non_interactive') {
    process.stdout.write(`${label}...\n`);
    return fn();
  }
  const s = clackSpinner();
  s.start(label);
  try {
    const result = await fn();
    s.stop(`${label} — done`);
    return result;
  } catch (err) {
    s.stop(`${label} — failed`, 1);
    throw err;
  }
}

// ── Prompt primitives ──────────────────────────────────────────────────────────

export interface SelectOption<V> {
  value: V;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** Mark a disabled option's label with a check + dimmed "(configured)" tag. */
function decorate<V>(o: SelectOption<V>): ClackOption<V> {
  if (o.disabled) {
    return { value: o.value, label: `${pc.green('✓')} ${pc.dim(o.label)}`, hint: o.hint ?? 'configured' } as ClackOption<V>;
  }
  return { value: o.value, label: o.label, hint: o.hint } as ClackOption<V>;
}

export async function select<V>(cfg: {
  message: string;
  options: SelectOption<V>[];
  initialValue?: V;
  default?: V;
}): Promise<V> {
  if (mode() === 'non_interactive') {
    if (cfg.default !== undefined) return cfg.default;
    throw new NonInteractiveError(`"${cfg.message}" requires a selection; pass a default or run interactively.`);
  }
  // @clack/prompts has no native "disabled": re-prompt when a disabled item is picked.
  while (true) {
    const res = unwrap(await clackSelect({
      message: cfg.message,
      options: cfg.options.map(decorate),
      initialValue: cfg.initialValue,
    }));
    const picked = cfg.options.find((o) => o.value === res);
    if (picked?.disabled) {
      clackLog.warn(`${picked.label} is already configured.`);
      continue;
    }
    return res as V;
  }
}

export async function multiselect<V>(cfg: {
  message: string;
  options: SelectOption<V>[];
  initialValues?: V[];
  required?: boolean;
  default?: V[];
}): Promise<V[]> {
  if (mode() === 'non_interactive') {
    if (cfg.default !== undefined) return cfg.default;
    throw new NonInteractiveError(`"${cfg.message}" requires a selection; pass a default or run interactively.`);
  }
  const res = unwrap(await clackMultiselect({
    message: cfg.message,
    options: cfg.options.map(decorate),
    initialValues: cfg.initialValues,
    required: cfg.required ?? false,
  }));
  // Drop any disabled option that slipped through.
  const disabled = new Set(cfg.options.filter((o) => o.disabled).map((o) => o.value));
  return (res as V[]).filter((v) => !disabled.has(v));
}

export async function text(cfg: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  default?: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  if (mode() === 'non_interactive') {
    if (cfg.default !== undefined) return cfg.default;
    throw new NonInteractiveError(`"${cfg.message}" requires input; pass a default or run interactively.`);
  }
  return unwrap(await clackText({
    message: cfg.message,
    placeholder: cfg.placeholder,
    initialValue: cfg.initialValue,
    validate: cfg.validate,
  })) as string;
}

export async function password(cfg: {
  message: string;
  default?: string;
  validate?: (v: string) => string | undefined;
}): Promise<string> {
  if (mode() === 'non_interactive') {
    if (cfg.default !== undefined) return cfg.default;
    throw new NonInteractiveError(`"${cfg.message}" requires a secret value; pass it as an argument or run interactively.`);
  }
  return unwrap(await clackPassword({ message: cfg.message, validate: cfg.validate })) as string;
}

export async function confirm(cfg: {
  message: string;
  initialValue?: boolean;
  default?: boolean;
}): Promise<boolean> {
  if (mode() === 'non_interactive') {
    if (cfg.default !== undefined) return cfg.default;
    throw new NonInteractiveError(`"${cfg.message}" requires a yes/no answer; pass a default or run interactively.`);
  }
  return unwrap(await clackConfirm({
    message: cfg.message,
    initialValue: cfg.initialValue ?? true,
  })) as boolean;
}

// ── Command menu (autocomplete-style palette) ─────────────────────────────────

/**
 * Interactive arrow-key command palette. Returns the selected command value,
 * or null in non_interactive mode (after printing a static list).
 */
export async function commandMenu(cfg: {
  message: string;
  options: SelectOption<string>[];
}): Promise<string | null> {
  if (mode() === 'non_interactive') {
    for (const o of cfg.options) {
      console.log(`  ${o.value.padEnd(20)} ${o.hint ?? ''}`.trimEnd());
    }
    return null;
  }
  const res = unwrap(await clackSelect({
    message: cfg.message,
    options: cfg.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
    maxItems: 12,
  }));
  return res as string;
}

// ── Logs ───────────────────────────────────────────────────────────────────────

export const log = {
  info: (m: string): void => (mode() === 'non_interactive' ? console.log(m) : clackLog.info(m)),
  success: (m: string): void => (mode() === 'non_interactive' ? console.log(m) : clackLog.success(m)),
  warn: (m: string): void => (mode() === 'non_interactive' ? console.warn(m) : clackLog.warn(m)),
  error: (m: string): void => (mode() === 'non_interactive' ? console.error(m) : clackLog.error(m)),
  step: (m: string): void => (mode() === 'non_interactive' ? console.log(m) : clackLog.step(m)),
};

// ── Note ─────────────────────────────────────────────────────────────────────

export function note(message: string, title?: string): void {
  if (mode() === 'non_interactive') {
    if (title) console.log(`${title}:`);
    console.log(message);
    return;
  }
  clackNote(message, title);
}

// ── Group (wizard flow with rollback on cancel) ───────────────────────────────

export function group<T extends Record<string, unknown>>(
  steps: {
    [K in keyof T]: (ctx: { results: Partial<T> }) => Promise<T[K]> | void;
  },
): Promise<T> {
  return clackGroup(steps as unknown as PromptGroup<T>, {
    onCancel: () => {
      clackCancel('Setup cancelled — no changes written.');
      process.exit(130);
    },
  }) as Promise<T>;
}

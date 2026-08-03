/**
 * A diagram plugin turns a natural-language prompt into a scene document
 * for its target diagram format. `diagram.create` calls exactly one plugin
 * per invocation, selected by `DiagramCreateInput.plugin` (default
 * `'excalidraw'`).
 */
export interface DiagramPlugin {
  name: string;
  /** Produce a scene document from a prompt. Throw to signal generation failure. */
  generate(prompt: string): Promise<Record<string, unknown>>;
}

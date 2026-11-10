/** Register the fcad_* tool family onto a DSH Cordis context (reversible). */
import { createToolDefinitions } from "../src/tooldefs.js";

/**
 * @param {object} ctx Cordis context exposing ctx.tools.register
 * @param {import('../src/registry.js').CadEngine} engine
 * @param {(definition: object) => object} defineTool host helper (identity in standalone mode)
 * @returns {{engine: object, names: string[], dispose: () => void}}
 */
export function registerTools(ctx, engine, defineTool = (definition) => definition) {
  if (!ctx || typeof ctx.tools?.register !== "function") {
    throw new TypeError("registerTools needs a DSH context with ctx.tools.register()");
  }
  const cleanups = [];
  const names = [];
  for (const definition of createToolDefinitions(engine)) {
    const result = ctx.tools.register(defineTool(definition));
    if (typeof result === "function") cleanups.push(result);
    names.push(definition.name);
  }
  return {
    engine,
    names,
    dispose() {
      for (const cleanup of cleanups) {
        try { cleanup(); } catch { /* disposers must not break shutdown */ }
      }
    },
  };
}

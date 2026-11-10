/**
 * DeepSeek Harness plugin entry point.
 *
 * Contract (verified against the installed Harness and the public plugin docs):
 *   - exports name / inject / apply(ctx, config)
 *   - tools are registered through ctx.tools.register(defineTool(definition))
 *   - registrations are reversible effects
 *   - package.json declares dsh.bundle.patch -> ./cordis.patch.yml
 */
import { DEFAULTS, normalizeConfig } from "../src/config.js";
import { CadEngine } from "../src/registry.js";
import { registerTools } from "./register.js";

export const name = "dsh-cad-freecad";
export const inject = ["tools"];

/** Config defaults + normalizer. Hard limits cannot be raised by a patch. */
export const Config = Object.freeze({
  defaults: DEFAULTS,
  normalize: normalizeConfig,
});

// The host ships this helper. In a standalone checkout (CLI, tests, plain
// `import`) it is absent, so registration falls back to the raw definitions.
let defineTool = (definition) => definition;
try {
  const host = await import("@deepseek-ai/dsh-tools");
  if (typeof host.defineTool === "function") defineTool = host.defineTool;
} catch {
  // Standalone mode — no Harness installed.
}

/**
 * @param {object} ctx Cordis context
 * @param {object} config composed config row from cordis.patch.yml
 * @returns {CadEngine} also returned for tests; the host ignores the value
 */
export function apply(ctx, config = {}) {
  const engine = new CadEngine(config);
  const registration = registerTools(ctx, engine, defineTool);
  if (typeof ctx.effect === "function") {
    ctx.effect(() => registration.dispose);
  }
  return engine;
}

export { CadEngine } from "../src/registry.js";
export { createToolDefinitions, TOOL_NAMES } from "../src/tooldefs.js";
export { normalizeConfig };

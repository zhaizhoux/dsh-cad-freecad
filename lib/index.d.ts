import type { CadEngine } from "../src/registry.js";
import type { normalizeConfig } from "../src/config.js";

export declare const name: "dsh-cad-freecad";
export declare const inject: readonly ["tools"];
export declare const Config: {
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly normalize: typeof normalizeConfig;
};
export declare function apply(ctx: unknown, config?: Record<string, unknown>): CadEngine;
export { CadEngine } from "../src/registry.js";
export { createToolDefinitions, TOOL_NAMES } from "../src/tooldefs.js";
export { normalizeConfig } from "../src/config.js";

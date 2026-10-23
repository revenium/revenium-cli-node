import { ENV_KEYS, DEFAULT_SYNC_INTERVAL_MS } from "../constants.js";
import { buildOptionalEnv } from "../../_core/config/optional-env.js";
import type { CursorConfig } from "../types.js";

export function buildCursorEnv(config: CursorConfig): Record<string, string> {
  return {
    [ENV_KEYS.REVENIUM_CURSOR_API_KEY]: config.cursorApiKey,
    [ENV_KEYS.REVENIUM_API_KEY]: config.reveniumApiKey,
    [ENV_KEYS.REVENIUM_ENDPOINT]: config.reveniumEndpoint,
    ...buildOptionalEnv(config, ENV_KEYS, DEFAULT_SYNC_INTERVAL_MS),
  };
}

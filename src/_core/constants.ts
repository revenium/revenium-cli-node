export const DEFAULT_REVENIUM_URL = "https://api.revenium.ai";

export const OTLP_PATH = "/meter/v2/otlp";

// Management-plane API (session attribution, etc.) lives under this context path — distinct
// from the OTLP ingest path above. Overridable per-environment via REVENIUM_MGMT_ENDPOINT.
export const MGMT_API_PATH_SUFFIX = "/profitstream";

export const CONFIG_FILE_MODE = 0o600;

export const CONFIG_DIR_MODE = 0o700;

export const REVENIUM_ENV_FILE = "revenium.env";

export const REVENIUM_FISH_FILE = "revenium.fish";

export const REVENIUM_API_KEY_ATTR = "revenium.api_key";

export const BACKFILL_DEDUP_WINDOW_RECORDS = 10_000;

export const MIDDLEWARE_SOURCE_KEY = "revenium.middleware.source";
export const MIDDLEWARE_SOURCE_LIVE = "revenium-cli";
export const MIDDLEWARE_SOURCE_BACKFILL = "revenium-cli-backfill";

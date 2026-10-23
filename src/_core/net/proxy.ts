const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

export function hasProxyConfigured(): boolean {
  return PROXY_ENV_VARS.some((name) => Boolean(process.env[name]?.trim()));
}

export async function installEnvProxyDispatcher(): Promise<boolean> {
  if (!hasProxyConfigured()) {
    return false;
  }

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
    return true;
  } catch {
    console.warn(
      "Warning: the proxy environment variable is not a usable URL (expected http://host:port) - continuing without a proxy.",
    );
    return false;
  }
}

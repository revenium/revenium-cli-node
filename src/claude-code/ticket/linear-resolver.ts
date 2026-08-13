import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const LINEAR_CREDENTIALS_PATH = join(homedir(), ".config", "linear", "credentials");
const RESOLVE_TIMEOUT_MS = 5_000;

async function loadLinearApiKey(): Promise<string | undefined> {
  try {
    if (!existsSync(LINEAR_CREDENTIALS_PATH)) return undefined;
    const content = await readFile(LINEAR_CREDENTIALS_PATH, "utf-8");
    const match = content.match(/LINEAR_API_KEY\s*=\s*(\S+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function resolveLinearTitle(ticketId: string): Promise<string | undefined> {
  const apiKey = await loadLinearApiKey();
  if (!apiKey) return undefined;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const query = JSON.stringify({
      query: `query($id: String!) { issue(id: $id) { title } }`,
      variables: { id: ticketId },
    });

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: query,
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      data?: { issue?: { title?: string } };
    };

    return data?.data?.issue?.title ?? undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

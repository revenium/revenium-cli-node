import { formatKeyPath, parseKeyPath, scanTomlLines } from "./toml-lines.js";

export interface OtelEntry {
  kind: "table" | "dotted-key" | "inline-table";
  name: string;
  line: number;
}

const OTEL_TABLE = "otel";

function isOtelPath(segments: string[]): boolean {
  return segments[0] === OTEL_TABLE;
}

function rootOtelEntry(text: string, line: number): OtelEntry | null {
  const parsed = parseKeyPath(text);
  if (!parsed || !parsed.rest.startsWith("=") || !isOtelPath(parsed.segments)) return null;

  return {
    kind: parsed.segments.length === 1 ? "inline-table" : "dotted-key",
    name: formatKeyPath(parsed.segments),
    line,
  };
}

export function findOtelEntries(tomlText: string): OtelEntry[] {
  const entries: OtelEntry[] = [];
  let insideRootTable = true;

  scanTomlLines(tomlText).forEach((line, index) => {
    if (line.continuation) return;

    const text = line.text.trim();
    if (text === "" || text.startsWith("#")) return;

    if (line.segments !== null) {
      insideRootTable = false;
      if (isOtelPath(line.segments)) {
        entries.push({ kind: "table", name: formatKeyPath(line.segments), line: index + 1 });
      }
      return;
    }

    if (!insideRootTable) return;

    const entry = rootOtelEntry(text, index + 1);
    if (entry) entries.push(entry);
  });

  return entries;
}

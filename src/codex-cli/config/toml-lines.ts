export interface TomlLine {
  text: string;
  segments: string[] | null;
  continuation: boolean;
}

const KEY_SEGMENT = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))/;
const MULTILINE_DELIMITERS = ['"""', "'''"];
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

interface ScanState {
  depth: number;
  multiline: string | null;
}

function decodeBasicString(raw: string): string {
  return raw.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, short, long, simple) => {
    if (short || long) return String.fromCodePoint(parseInt(short ?? long, 16));
    return ESCAPES[simple] ?? simple;
  });
}

export interface KeyPath {
  segments: string[];
  rest: string;
}

export function parseKeyPath(input: string): KeyPath | null {
  const segments: string[] = [];
  let rest = input;

  for (;;) {
    rest = rest.trimStart();
    const match = KEY_SEGMENT.exec(rest);
    if (!match) return null;

    segments.push(match[1] !== undefined ? decodeBasicString(match[1]) : (match[2] ?? match[3]));
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(".")) return { segments, rest };
    rest = rest.slice(1);
  }
}

function tableHeaderSegments(rawLine: string): string[] | null {
  const line = rawLine.trim();
  if (!line.startsWith("[")) return null;

  const isArrayTable = line.startsWith("[[");
  const parsed = parseKeyPath(line.slice(isArrayTable ? 2 : 1));
  if (!parsed) return null;

  const closing = isArrayTable ? "]]" : "]";
  if (!parsed.rest.startsWith(closing)) return null;

  const trailing = parsed.rest.slice(closing.length).trim();
  if (trailing !== "" && !trailing.startsWith("#")) return null;

  return parsed.segments;
}

export function formatKeyPath(segments: string[]): string {
  return segments
    .map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : `"${segment}"`))
    .join(".");
}

function singleLineStringEnd(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;

  while (index < text.length) {
    if (quote === '"' && text[index] === "\\") index += 2;
    else if (text[index] === quote) return index + 1;
    else index++;
  }

  return text.length;
}

function scanLine(text: string, state: ScanState): ScanState {
  let { depth, multiline } = state;
  let index = 0;

  while (index < text.length) {
    if (multiline !== null) {
      if (multiline === '"""' && text[index] === "\\") index += 2;
      else if (text.startsWith(multiline, index)) {
        index += multiline.length;
        multiline = null;
      } else index++;
      continue;
    }

    const opener = MULTILINE_DELIMITERS.find((delimiter) => text.startsWith(delimiter, index));
    if (opener) {
      multiline = opener;
      index += opener.length;
      continue;
    }

    const char = text[index];
    if (char === "#") break;
    if (char === '"' || char === "'") {
      index = singleLineStringEnd(text, index);
      continue;
    }
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    index++;
  }

  return { depth, multiline };
}

export function scanTomlLines(tomlText: string): TomlLine[] {
  let state: ScanState = { depth: 0, multiline: null };

  return tomlText.split("\n").map((text) => {
    const continuation = state.depth > 0 || state.multiline !== null;
    const segments = continuation ? null : tableHeaderSegments(text);
    state = scanLine(text, state);
    return { text, segments, continuation };
  });
}

export function statementEndLine(lines: TomlLine[], startLine: number): number {
  let line = startLine;
  while (line < lines.length && lines[line].continuation) line++;
  return line;
}

export function readTableBody(lines: TomlLine[], name: string): string[] | null {
  const wanted = name.split(".");
  const body: string[] = [];
  let found = false;
  let inside = false;

  for (const line of lines) {
    if (!line.continuation && line.segments !== null) {
      inside =
        line.segments.length === wanted.length && line.segments.every((s, i) => s === wanted[i]);
      found = found || inside;
      continue;
    }
    if (inside) body.push(line.text);
  }

  return found ? body : null;
}

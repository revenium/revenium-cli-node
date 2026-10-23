import { describe, it, expect } from "vitest";
import { findOtelEntries } from "../../../src/codex-cli/config/otel-entries.js";

describe("findOtelEntries — table layouts setup would remove", () => {
  it("reports a nested exporter sub-table written as its own header", () => {
    const toml =
      '[otel.trace_exporter.otlp-http]\nendpoint = "https://collector.customer.example/v1/traces"\n';

    expect(findOtelEntries(toml)).toEqual([
      { kind: "table", name: "otel.trace_exporter.otlp-http", line: 1 },
    ]);
  });

  it("reports an indented [otel] header", () => {
    const toml = '  [otel]\nexporter = { otlp-http = { endpoint = "https://x.example" } }\n';

    expect(findOtelEntries(toml)).toEqual([{ kind: "table", name: "otel", line: 1 }]);
  });

  it("reports an otel array-of-tables", () => {
    expect(findOtelEntries("[[otel.processors]]\nkind = 2\n")).toEqual([
      { kind: "table", name: "otel.processors", line: 1 },
    ]);
  });

  it("reports a plain [otel] header", () => {
    expect(findOtelEntries('[otel]\nexporter = "none"\n')).toEqual([
      { kind: "table", name: "otel", line: 1 },
    ]);
  });
});

describe("findOtelEntries — dotted keys", () => {
  it("reports a root-level dotted otel key", () => {
    const toml = 'otel.exporter = { otlp-http = { endpoint = "https://x.example" } }\n';

    expect(findOtelEntries(toml)).toEqual([{ kind: "dotted-key", name: "otel.exporter", line: 1 }]);
  });

  it("ignores a dotted otel key owned by another table", () => {
    expect(findOtelEntries('[profiles.foo]\notel.endpoint = "x"\n')).toEqual([]);
  });

  it("ignores a dotted otel key owned by a table with a bracket in its quoted name", () => {
    expect(findOtelEntries('[profiles."a[b"]\notel.endpoint = "x"\n')).toEqual([]);
  });

  it("reports a quoted dotted otel key", () => {
    expect(findOtelEntries('"otel".environment = "prod"\n')).toEqual([
      { kind: "dotted-key", name: "otel.environment", line: 1 },
    ]);
  });

  it("reports a dotted otel key written with spaces around the separator", () => {
    expect(findOtelEntries('otel . environment = "prod"\n')).toEqual([
      { kind: "dotted-key", name: "otel.environment", line: 1 },
    ]);
  });
});

describe("findOtelEntries — headers the anchored form used to miss", () => {
  it("reports a header carrying a trailing comment", () => {
    const toml = '[otel]  # my datadog export\nexporter = { otlp-http = { endpoint = "x" } }\n';

    expect(findOtelEntries(toml)).toEqual([{ kind: "table", name: "otel", line: 1 }]);
  });

  it("reports a quoted header", () => {
    expect(findOtelEntries('["otel"]\nexporter = "none"\n')).toEqual([
      { kind: "table", name: "otel", line: 1 },
    ]);
  });

  it("never treats an array value row as a header", () => {
    expect(findOtelEntries('matrix = [\n  [1, 2]\n]\notel.endpoint = "x"\n')).toEqual([
      { kind: "dotted-key", name: "otel.endpoint", line: 4 },
    ]);
  });
});

describe("findOtelEntries — root inline tables", () => {
  it("reports a root otel assignment written as an inline table", () => {
    expect(findOtelEntries('otel = { exporter = "none" }\n')).toEqual([
      { kind: "inline-table", name: "otel", line: 1 },
    ]);
  });

  it("reports a quoted root otel assignment", () => {
    expect(findOtelEntries('"otel" = { exporter = "none" }\n')).toEqual([
      { kind: "inline-table", name: "otel", line: 1 },
    ]);
  });

  it("reports a root otel inline table spanning several lines", () => {
    const toml = 'otel = {\n  exporter = "none",\n}\nmodel = "o3"\n';

    expect(findOtelEntries(toml)).toEqual([{ kind: "inline-table", name: "otel", line: 1 }]);
  });
});

describe("findOtelEntries — quoted keys are not table paths", () => {
  it("ignores a header whose single quoted key merely contains a dot", () => {
    expect(findOtelEntries('["otel.exporter"]\nendpoint = "https://x.example"\n')).toEqual([]);
  });

  it("ignores a root key whose single quoted name merely contains a dot", () => {
    expect(findOtelEntries('"otel.exporter" = { endpoint = "https://x.example" }\n')).toEqual([]);
  });

  it("reports a header that spells otel with an escape sequence", () => {
    expect(findOtelEntries('["ot\\u0065l"]\nexporter = "none"\n')).toEqual([
      { kind: "table", name: "otel", line: 1 },
    ]);
  });
});

describe("findOtelEntries — multi-line strings", () => {
  it("reports a header that follows a multi-line string holding an unbalanced bracket", () => {
    const toml =
      'developer_instructions = """\nTicket ids look like [ABC-123\n"""\n\n[otel]\nexporter = "none"\n';

    expect(findOtelEntries(toml)).toEqual([{ kind: "table", name: "otel", line: 5 }]);
  });

  it("reports a header that follows a literal multi-line string", () => {
    const toml = "notes = '''\nUse { to open a table\n'''\n[otel.exporter]\nendpoint = \"x\"\n";

    expect(findOtelEntries(toml)).toEqual([{ kind: "table", name: "otel.exporter", line: 4 }]);
  });

  it("never treats a header inside a multi-line string as a real header", () => {
    const toml = 'developer_instructions = """\n[otel]\n"""\nmodel = "o3"\n';

    expect(findOtelEntries(toml)).toEqual([]);
  });
});

describe("findOtelEntries — what must never match", () => {
  it("ignores a commented-out header and a key that merely starts with otel", () => {
    expect(findOtelEntries("# [otel]\notelish = 1\n")).toEqual([]);
  });

  it("ignores an unrelated table whose name starts with otel", () => {
    expect(findOtelEntries("[otel_extra]\ncustom = true\n")).toEqual([]);
  });

  it("returns nothing for an empty file", () => {
    expect(findOtelEntries("")).toEqual([]);
  });

  it("reports a trailing [otel] section with no trailing newline", () => {
    expect(findOtelEntries('model = "gpt-5"\n[otel]')).toEqual([
      { kind: "table", name: "otel", line: 2 },
    ]);
  });
});

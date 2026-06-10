import { SECRET_KEY_PATTERN } from "./validation";

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  '"': '"',
};

/** Strips one trailing carriage return (CRLF tolerance). */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Removes an inline ` # comment` (a `#` preceded by whitespace or at the start) and trims. */
function parseUnquoted(raw: string): string {
  return raw.replace(/(^|\s)#.*$/, "").trim();
}

interface QuotedScan {
  value: string;
  /** Index of the line on which the closing quote was found, or null if unterminated. */
  endLine: number | null;
}

/**
 * Scans a double-quoted value starting at `startLine` (whose raw value portion,
 * trimmed, begins with `"`). Processes \n, \t, \r, \\ and \" escapes; may span
 * multiple lines. Content after the closing quote is ignored.
 */
function scanDoubleQuoted(
  lines: readonly string[],
  startLine: number,
  opened: string,
): QuotedScan {
  let value = "";
  let segment = opened; // text after the opening quote on the current line
  let lineIndex = startLine;
  for (;;) {
    let i = 0;
    while (i < segment.length) {
      const ch = segment.charAt(i);
      if (ch === "\\" && i + 1 < segment.length) {
        const next = segment.charAt(i + 1);
        const mapped = DOUBLE_QUOTE_ESCAPES[next];
        value += mapped ?? `\\${next}`;
        i += 2;
        continue;
      }
      if (ch === '"') {
        return { value, endLine: lineIndex };
      }
      value += ch;
      i += 1;
    }
    lineIndex += 1;
    if (lineIndex >= lines.length) {
      return { value, endLine: null };
    }
    value += "\n";
    segment = stripCr(lines[lineIndex] ?? "");
  }
}

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = stripCr(lines[i] ?? "");
    const currentLine = i;
    i += 1;

    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const assignment = trimmedLine.replace(/^export\s+/, "");
    const eq = assignment.indexOf("=");
    if (eq === -1) continue;

    const key = assignment.slice(0, eq).trim();
    if (!SECRET_KEY_PATTERN.test(key)) continue;

    const rawValue = assignment.slice(eq + 1);
    const trimmedValue = rawValue.trim();

    if (trimmedValue.startsWith('"')) {
      const scan = scanDoubleQuoted(lines, currentLine, trimmedValue.slice(1));
      if (scan.endLine !== null) {
        result[key] = scan.value;
        i = scan.endLine + 1;
        continue;
      }
      // Unterminated: fall back to unquoted parsing of this line only.
      result[key] = parseUnquoted(rawValue);
      continue;
    }

    if (trimmedValue.startsWith("'")) {
      const close = trimmedValue.indexOf("'", 1);
      if (close !== -1) {
        result[key] = trimmedValue.slice(1, close);
        continue;
      }
      // Unterminated: fall back to unquoted parsing.
    }

    result[key] = parseUnquoted(rawValue);
  }
  return result;
}

function needsQuoting(value: string): boolean {
  return value.length === 0 || /[\s#"']/.test(value);
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

export function serializeDotenv(secrets: Record<string, string>): string {
  let out = "";
  for (const [key, value] of Object.entries(secrets)) {
    const encoded = needsQuoting(value)
      ? `"${escapeDoubleQuoted(value)}"`
      : value;
    out += `${key}=${encoded}\n`;
  }
  return out;
}

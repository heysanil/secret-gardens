import { describe, expect, test } from "bun:test";
import { parseDotenv, serializeDotenv } from "./dotenv";

describe("parseDotenv", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseDotenv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips an optional export prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("treats export with extra spaces as a prefix", () => {
    expect(parseDotenv("export   FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("export itself is a valid key when followed directly by =", () => {
    expect(parseDotenv("export=bar")).toEqual({ export: "bar" });
  });

  test("skips blank lines", () => {
    expect(parseDotenv("\n\nFOO=bar\n   \n")).toEqual({ FOO: "bar" });
  });

  test("skips full-line comments", () => {
    expect(parseDotenv("# a comment\nFOO=bar\n  # indented comment")).toEqual({
      FOO: "bar",
    });
  });

  test("strips inline comments from unquoted values", () => {
    expect(parseDotenv("FOO=bar # comment here")).toEqual({ FOO: "bar" });
  });

  test("keeps # without preceding whitespace in unquoted values", () => {
    expect(parseDotenv("FOO=bar#notcomment")).toEqual({
      FOO: "bar#notcomment",
    });
  });

  test("an unquoted value that is only a comment becomes empty", () => {
    expect(parseDotenv("FOO= # just a comment")).toEqual({ FOO: "" });
  });

  test("does not strip inline comments inside double quotes", () => {
    expect(parseDotenv('FOO="bar # not a comment"')).toEqual({
      FOO: "bar # not a comment",
    });
  });

  test("does not strip inline comments inside single quotes", () => {
    expect(parseDotenv("FOO='bar # not a comment'")).toEqual({
      FOO: "bar # not a comment",
    });
  });

  test("strips comments after a closing double quote", () => {
    expect(parseDotenv('FOO="bar" # comment')).toEqual({ FOO: "bar" });
  });

  test("strips comments after a closing single quote", () => {
    expect(parseDotenv("FOO='bar' # comment")).toEqual({ FOO: "bar" });
  });

  test("removes surrounding double quotes", () => {
    expect(parseDotenv('FOO="bar"')).toEqual({ FOO: "bar" });
  });

  test("removes surrounding single quotes", () => {
    expect(parseDotenv("FOO='bar'")).toEqual({ FOO: "bar" });
  });

  test("double-quoted empty value", () => {
    expect(parseDotenv('FOO=""')).toEqual({ FOO: "" });
  });

  test("unquoted empty value", () => {
    expect(parseDotenv("FOO=")).toEqual({ FOO: "" });
  });

  test('processes \\n, \\t, \\\\ and \\" escapes in double-quoted values', () => {
    expect(parseDotenv('FOO="a\\nb\\tc\\\\d\\"e"')).toEqual({
      FOO: 'a\nb\tc\\d"e',
    });
  });

  test("leaves unknown escape sequences literal in double-quoted values", () => {
    expect(parseDotenv('FOO="a\\xb"')).toEqual({ FOO: "a\\xb" });
  });

  test("double-quoted values may span multiple lines", () => {
    expect(parseDotenv('FOO="line1\nline2\nline3"\nBAR=after')).toEqual({
      FOO: "line1\nline2\nline3",
      BAR: "after",
    });
  });

  test("single-quoted values are literal (no escape processing)", () => {
    expect(parseDotenv("FOO='a\\nb\\\\c'")).toEqual({ FOO: "a\\nb\\\\c" });
  });

  test("single quotes inside double quotes are literal and vice versa", () => {
    expect(parseDotenv('A="it\'s here"\nB=\'say "hi"\'')).toEqual({
      A: "it's here",
      B: 'say "hi"',
    });
  });

  test("trims unquoted values", () => {
    expect(parseDotenv("FOO=   bar   ")).toEqual({ FOO: "bar" });
  });

  test("preserves interior whitespace of unquoted values", () => {
    expect(parseDotenv("FOO=bar baz")).toEqual({ FOO: "bar baz" });
  });

  test("tolerates CRLF line endings", () => {
    expect(parseDotenv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("normalizes CRLF inside multiline double-quoted values to LF", () => {
    expect(parseDotenv('FOO="line1\r\nline2"\r\n')).toEqual({
      FOO: "line1\nline2",
    });
  });

  test("later duplicate keys win", () => {
    expect(parseDotenv("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
  });

  test("ignores lines without =", () => {
    expect(parseDotenv("garbage line\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  test("splits on the first = only", () => {
    expect(parseDotenv("FOO=a=b=c")).toEqual({ FOO: "a=b=c" });
  });

  test("ignores keys that do not match the key pattern", () => {
    expect(parseDotenv("1FOO=x\nMY-KEY=y\nMY KEY=z\nVALID=ok")).toEqual({
      VALID: "ok",
    });
  });

  test("accepts indented assignments", () => {
    expect(parseDotenv("  FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("an unterminated double quote falls back to unquoted parsing of the line", () => {
    expect(parseDotenv('FOO="unterminated\nBAR=ok')).toEqual({
      FOO: '"unterminated',
      BAR: "ok",
    });
  });

  test("empty content yields an empty record", () => {
    expect(parseDotenv("")).toEqual({});
  });
});

describe("serializeDotenv", () => {
  test("simple values are emitted bare", () => {
    expect(serializeDotenv({ FOO: "bar" })).toBe("FOO=bar\n");
  });

  test("empty record serializes to an empty string", () => {
    expect(serializeDotenv({})).toBe("");
  });

  test("empty values are double-quoted", () => {
    expect(serializeDotenv({ FOO: "" })).toBe('FOO=""\n');
  });

  test("values with spaces are double-quoted", () => {
    expect(serializeDotenv({ FOO: "a b" })).toBe('FOO="a b"\n');
  });

  test("values with # are double-quoted", () => {
    expect(serializeDotenv({ FOO: "a#b" })).toBe('FOO="a#b"\n');
  });

  test("newlines are escaped inside double quotes", () => {
    expect(serializeDotenv({ FOO: "a\nb" })).toBe('FOO="a\\nb"\n');
  });

  test("tabs are escaped inside double quotes", () => {
    expect(serializeDotenv({ FOO: "a\tb" })).toBe('FOO="a\\tb"\n');
  });

  test("double quotes and backslashes are escaped", () => {
    expect(serializeDotenv({ FOO: 'say "hi" \\o/' })).toBe(
      'FOO="say \\"hi\\" \\\\o/"\n',
    );
  });

  test("values with single quotes are double-quoted", () => {
    expect(serializeDotenv({ FOO: "it's" })).toBe('FOO="it\'s"\n');
  });

  test("leading/trailing whitespace forces quoting", () => {
    expect(serializeDotenv({ FOO: " padded " })).toBe('FOO=" padded "\n');
  });

  test("preserves insertion order", () => {
    const result = serializeDotenv({ ZEBRA: "1", ALPHA: "2", MIKE: "3" });
    expect(result).toBe("ZEBRA=1\nALPHA=2\nMIKE=3\n");
  });
});

describe("round-trip: parseDotenv(serializeDotenv(x)) deep-equals x", () => {
  const fixtures: Record<string, Record<string, string>> = {
    "multiline PEM key": {
      PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nq3qLhV29Jt+a8sFsX/qe3J0V\n-----END PRIVATE KEY-----\n",
    },
    "JSON blob value": {
      CONFIG:
        '{"name":"app","nested":{"list":[1,2,3]},"msg":"hi #1 \\"quoted\\""}',
    },
    "value with #": { A: "value#hash", B: "value # spaced hash" },
    "value with both quote types": {
      QUOTES: "it's a \"double\" and 'single' mix",
    },
    emoji: { EMOJI: "🔐 secrets 🚀 ünïcödé ✨" },
    "empty string": { EMPTY: "" },
    "whitespace soup": {
      PAD: "  leading and trailing  ",
      TAB: "a\tb",
      BLANK: "   ",
    },
    newlines: {
      LF: "a\nb",
      CRLF: "a\r\nb",
      CR: "a\rb",
      TRAILING: "ends with newline\n",
    },
    backslashes: {
      WIN_PATH: "C:\\Users\\gardens\\file.txt",
      DOUBLE: "a\\\\b",
      END: "ends\\",
    },
    "equals signs": {
      EQ: "a=b=c",
      URL: "postgres://u:p@host:5432/db?ssl=true&x=1",
    },
    "looks pre-quoted": { DQ: '"already quoted"', SQ: "'already quoted'" },
    "escape-sequence lookalikes": {
      FAKE: "literal\\nnot-newline",
      MIX: 'tab\there "and" \\n',
    },
    "multiple keys": {
      DATABASE_URL: "postgres://localhost/db",
      API_KEY: "abc123",
      _PRIVATE: "x",
      KEY2: "with space",
    },
  };

  for (const [name, record] of Object.entries(fixtures)) {
    test(name, () => {
      expect(parseDotenv(serializeDotenv(record))).toEqual(record);
    });
  }

  test("seeded fuzz over tricky characters", () => {
    // Deterministic LCG so failures are reproducible.
    let seed = 0xc0ffee;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pool = [
      "a",
      "Z",
      "0",
      " ",
      "\t",
      "\n",
      "\r",
      "#",
      '"',
      "'",
      "\\",
      "=",
      "$",
      "{",
      "}",
      "😀",
      "é",
      "中",
      "n",
      "t",
    ];
    for (let i = 0; i < 200; i++) {
      const record: Record<string, string> = {};
      const keyCount = 1 + Math.floor(next() * 4);
      for (let k = 0; k < keyCount; k++) {
        const len = Math.floor(next() * 24);
        let value = "";
        for (let c = 0; c < len; c++) {
          value += pool[Math.floor(next() * pool.length)];
        }
        record[`KEY_${i}_${k}`] = value;
      }
      expect(parseDotenv(serializeDotenv(record))).toEqual(record);
    }
  });
});

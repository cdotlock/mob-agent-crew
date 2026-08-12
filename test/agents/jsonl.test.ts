import { describe, expect, it } from "vitest";
import { JsonlDecodeError, JsonlDecoder, encodeJsonl } from "../../src/agents/index.js";

describe("JsonlDecoder", () => {
  it("preserves strict LF framing across split UTF-8 chunks", () => {
    const decoder = new JsonlDecoder<{ text?: string; n?: number }>();
    const bytes = Buffer.from('{"text":"left\u2028😀right"}\n{"n":2}\r\n', "utf8");
    const emojiStart = bytes.indexOf(Buffer.from("😀", "utf8"));

    expect(decoder.push(bytes.subarray(0, emojiStart + 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(emojiStart + 2, bytes.length - 1))).toEqual([
      { text: "left\u2028😀right" },
    ]);
    expect(decoder.end(bytes.subarray(bytes.length - 1))).toEqual([{ n: 2 }]);
  });

  it("flushes a final frame without a newline and encodes one LF", () => {
    const decoder = new JsonlDecoder<{ ok: boolean }>();
    expect(decoder.push('{"ok":true')).toEqual([]);
    expect(decoder.end("}")).toEqual([{ ok: true }]);
    expect(encodeJsonl({ ok: true })).toBe('{"ok":true}\n');
  });

  it("rejects malformed and oversized frames", () => {
    expect(() => new JsonlDecoder().push("not-json\n")).toThrowError(
      JsonlDecodeError,
    );
    expect(() =>
      new JsonlDecoder({ maxFrameBytes: 4 }).push('{"long":true}\n'),
    ).toThrowError(/exceeds 4 bytes/);
  });
});

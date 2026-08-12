import { StringDecoder } from "node:string_decoder";

export interface JsonlDecoderOptions {
  readonly maxFrameBytes?: number;
  readonly allowEmptyLines?: boolean;
}

export class JsonlDecodeError extends Error {
  readonly line: string;
  readonly cause?: unknown;

  constructor(message: string, line: string, cause?: unknown) {
    super(message);
    this.name = "JsonlDecodeError";
    this.line = line;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Strict LF-framed JSONL decoder. It intentionally does not use readline:
 * readline also treats U+2028/U+2029 as separators, while Pi/OMP frame on LF.
 */
export class JsonlDecoder<T = unknown> {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxFrameBytes: number;
  readonly #allowEmptyLines: boolean;
  #buffer = "";

  constructor(options: JsonlDecoderOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.#allowEmptyLines = options.allowEmptyLines ?? true;
  }

  push(chunk: Uint8Array | string): T[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    return this.#extract(false);
  }

  end(chunk?: Uint8Array | string): T[] {
    if (chunk !== undefined) {
      this.#buffer +=
        typeof chunk === "string"
          ? chunk
          : this.#decoder.write(Buffer.from(chunk));
    }
    this.#buffer += this.#decoder.end();
    return this.#extract(true);
  }

  #extract(flush: boolean): T[] {
    const frames: T[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const rawLine = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.#parseLine(line, frames);
      newlineIndex = this.#buffer.indexOf("\n");
    }

    this.#assertFrameSize(this.#buffer);
    if (flush && this.#buffer.length > 0) {
      const line = this.#buffer.endsWith("\r")
        ? this.#buffer.slice(0, -1)
        : this.#buffer;
      this.#buffer = "";
      this.#parseLine(line, frames);
    }

    return frames;
  }

  #parseLine(line: string, frames: T[]): void {
    this.#assertFrameSize(line);
    if (line.length === 0 && this.#allowEmptyLines) return;
    try {
      frames.push(JSON.parse(line) as T);
    } catch (error) {
      throw new JsonlDecodeError("Invalid JSONL frame", line, error);
    }
  }

  #assertFrameSize(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes) {
      throw new JsonlDecodeError(
        `JSONL frame exceeds ${this.#maxFrameBytes} bytes`,
        line,
      );
    }
  }
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

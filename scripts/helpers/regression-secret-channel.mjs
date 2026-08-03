const minimumSecretBytes = 8;
const maximumSecretBytes = 4096;
const maximumFrameCharacters = 5462;
const maximumBufferedCharacters = 2_000_000;
const maximumSecretFrames = 4096;
const maximumDecodedSecretBytes = 1_048_576;

export function encodeRegressionSecretFrame(value) {
  const payload = Buffer.from(String(value ?? ""), "utf8");
  if (payload.length < minimumSecretBytes || payload.length > maximumSecretBytes) return "";
  return `${payload.toString("base64url")}\n`;
}

export class RegressionSecretFrameCollector {
  #buffer = "";
  #error = "";
  #values = new Set();
  #finished = false;
  #frameCount = 0;
  #decodedBytes = 0;

  push(chunk) {
    if (this.#finished) throw new Error("regression secret collector is already finished");
    if (this.#error) return;
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    if (this.#buffer.length > maximumBufferedCharacters) {
      this.fail("regression child secret report exceeded its bounded buffer");
      return;
    }
    this.#consumeCompleteFrames();
  }

  fail(message) {
    if (!this.#error) this.#error = String(message || "regression child secret report failed");
    this.#buffer = "";
  }

  finish() {
    if (this.#finished) throw new Error("regression secret collector can only finish once");
    this.#finished = true;
    this.#consumeCompleteFrames();
    if (!this.#error && this.#buffer.length > 0) {
      this.fail("regression child emitted an incomplete secret report frame");
    }
    return Object.freeze({
      ok: !this.#error,
      error: this.#error || null,
      values: Object.freeze([...this.#values])
    });
  }

  #consumeCompleteFrames() {
    while (!this.#error) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!frame || frame.length > maximumFrameCharacters || !/^[A-Za-z0-9_-]+$/.test(frame)) {
        this.fail("regression child emitted an invalid secret report frame");
        return;
      }
      const decoded = Buffer.from(frame, "base64url");
      if (decoded.toString("base64url") !== frame
        || decoded.length < minimumSecretBytes
        || decoded.length > maximumSecretBytes) {
        this.fail("regression child emitted a non-canonical secret report frame");
        return;
      }
      if (this.#frameCount >= maximumSecretFrames) {
        this.fail("regression child secret report exceeded its cumulative frame limit");
        return;
      }
      if (decoded.length > maximumDecodedSecretBytes - this.#decodedBytes) {
        this.fail("regression child secret report exceeded its cumulative decoded byte limit");
        return;
      }
      this.#frameCount += 1;
      this.#decodedBytes += decoded.length;
      const value = decoded.toString("utf8");
      if (!Buffer.from(value, "utf8").equals(decoded)) {
        this.fail("regression child emitted a non-UTF-8 secret report frame");
        return;
      }
      this.#values.add(value);
    }
  }
}

import { createWriteStream } from 'node:fs';

// Both a wrapped ring buffer and a restarted MCP process lose the recording
// silently — the one outcome that wastes an entire game session. This is the
// escape hatch, off by default.
export class NdjsonSink {
  #stream = null;
  #disabled = false;

  constructor({ path, onError = () => {}, createStream = (p) => createWriteStream(p, { flags: 'a' }) }) {
    this.path = path;
    this.onError = onError;
    this.#stream = createStream(path);
    this.#stream.on('error', (err) => this.#disable(err?.message ?? String(err)));
  }

  get disabled() {
    return this.#disabled;
  }

  // A full disk must never terminate the recording: the in-memory timeline is
  // still evidence, and losing it because the file failed would be the worse
  // of the two outcomes.
  #disable(message) {
    if (this.#disabled) return;
    this.#disabled = true;
    this.onError(`recording file ${this.path} disabled: ${message}`);
  }

  write(entry) {
    if (this.#disabled || this.#stream === null) return false;
    try {
      this.#stream.write(`${JSON.stringify(entry)}\n`);
      return true;
    } catch (err) {
      this.#disable(err?.message ?? String(err));
      return false;
    }
  }

  close() {
    const stream = this.#stream;
    this.#stream = null;
    this.#disabled = true;
    try {
      stream?.end();
    } catch {
      // already gone
    }
  }
}

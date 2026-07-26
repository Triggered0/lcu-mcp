export class RingBuffer {
  #entries = [];
  #nextSeq = 1;

  constructor(size = 1000) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`RingBuffer size must be a positive integer, got ${size}`);
    this.size = size;
  }

  get length() {
    return this.#entries.length;
  }

  push(entry) {
    const stored = { seq: this.#nextSeq, ts: Date.now(), ...entry };
    this.#nextSeq += 1;
    this.#entries.push(stored);
    if (this.#entries.length > this.size) this.#entries.splice(0, this.#entries.length - this.size);
    return stored;
  }

  since(seq = 0, limit = 100, filter = null) {
    const oldestSeq = this.#entries.length > 0 ? this.#entries[0].seq : this.#nextSeq;
    const dropped = Math.max(0, oldestSeq - 1 - seq);
    let matching = this.#entries.filter((e) => e.seq > seq);
    if (filter) matching = matching.filter((e) => typeof e.uri === 'string' && e.uri.startsWith(filter));
    const entries = matching.slice(0, limit);
    const cursor = entries.length > 0 ? entries[entries.length - 1].seq : seq;
    return { entries, cursor, dropped, remaining: matching.length - entries.length };
  }

  clear() {
    this.#entries = [];
  }
}

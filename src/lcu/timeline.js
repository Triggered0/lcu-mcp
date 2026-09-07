// A ring bounded by two budgets at once. Entry size varies by two orders of
// magnitude across LCU URIs, so a count-only ring has unpredictable memory
// under a firehose; a byte-only ring has unpredictable depth. Evicting on
// whichever fills first bounds both.
export class TimelineBuffer {
  // Entries are held as { stored, bytes } so the measured size never leaks
  // into the entry a caller sees.
  #entries = [];
  #nextSeq = 1;
  #bytes = 0;
  #droppedTotal = 0;

  constructor({ maxEntries, maxBytes = Infinity, clock }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`TimelineBuffer maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!(maxBytes > 0)) {
      throw new Error(`TimelineBuffer maxBytes must be positive, got ${maxBytes}`);
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.clock = clock;
  }

  get length() {
    return this.#entries.length;
  }

  get bytes() {
    return this.#bytes;
  }

  get droppedTotal() {
    return this.#droppedTotal;
  }

  // seq/ts/wallTs go last: the buffer owns them, and an entry that happens to
  // carry one of those fields must not be able to overwrite the cursor's
  // numbering or restamp itself.
  push(entry) {
    const stored = { ...entry, seq: this.#nextSeq, ts: this.clock.now(), wallTs: this.clock.wall() };
    this.#nextSeq += 1;
    const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    this.#entries.push({ stored, bytes });
    this.#bytes += bytes;
    this.#evict();
    return stored;
  }

  // The length > 1 guard keeps a single entry larger than the whole byte
  // budget rather than evicting it immediately and recording nothing at all.
  #evict() {
    while (
      this.#entries.length > this.maxEntries ||
      (this.#bytes > this.maxBytes && this.#entries.length > 1)
    ) {
      const removed = this.#entries.shift();
      this.#bytes -= removed.bytes;
      this.#droppedTotal += 1;
    }
  }

  select({ cursor = 0, since = null, until = null, limit = 100, kinds = null, predicate = null } = {}) {
    // A negative cursor would otherwise inflate `dropped` past what was pushed.
    const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const oldestSeq = this.#entries.length > 0 ? this.#entries[0].stored.seq : this.#nextSeq;
    const dropped = Math.max(0, oldestSeq - 1 - from);

    let matching = this.#entries.map((e) => e.stored).filter((e) => e.seq > from);
    if (since !== null) matching = matching.filter((e) => e.ts >= since);
    if (until !== null) matching = matching.filter((e) => e.ts <= until);
    if (kinds !== null) matching = matching.filter((e) => kinds.includes(e.kind));
    if (predicate !== null) matching = matching.filter(predicate);

    const entries = matching.slice(0, limit);
    const next = entries.length > 0 ? entries[entries.length - 1].seq : from;
    return { entries, cursor: next, dropped, remaining: matching.length - entries.length };
  }

  clear() {
    this.#entries = [];
    this.#bytes = 0;
  }
}

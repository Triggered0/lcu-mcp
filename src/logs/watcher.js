import { open, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { TimelineBuffer } from '../lcu/timeline.js';
import { createClock } from '../clock.js';
import { parseLogLine } from './parser.js';

export class LogWatchTailer {
  #finder;
  #config;
  #secrets;
  #clock;
  #buffer;
  #running = false;
  #target = null;
  #filePath = null;
  #offset = 0;
  #fsWatcher = null;
  #interval = null;
  #baseWallTime = 0;
  #drainPromise = null;
  #needsAnotherDrain = false;
  #remainder = '';

  constructor({ finder, config = {}, secrets = () => [], clock = createClock() } = {}) {
    this.#finder = finder;
    this.#config = config;
    this.#secrets = secrets;
    this.#clock = clock;
    this.#buffer = new TimelineBuffer({
      maxEntries: config.logWatchBufferSize ?? 5000,
      clock: this.#clock
    });
  }

  statusSnapshot() {
    return {
      running: this.#running,
      target: this.#target,
      filePath: this.#filePath,
      offset: this.#offset,
      entries: this.#buffer.length,
      droppedTotal: this.#buffer.droppedTotal
    };
  }

  async start({ target = 'client' } = {}) {
    if (this.#running) {
      if (this.#target === target) return { alreadyRunning: true, target, filePath: this.#filePath };
      await this.stop();
    }

    this.#target = target;
    this.#filePath = await this.#finder.resolveActiveLogFile(target);
    const s = await stat(this.#filePath);
    this.#offset = s.size;
    this.#remainder = '';
    this.#buffer.clear();
    this.#running = true;

    // Detect base wall time from initial lines if possible
    try {
      const handle = await open(this.#filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(2048, s.size));
        await handle.read(buf, 0, buf.length, 0);
        const match = buf.toString('utf8').match(/Logging started at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/);
        if (match) {
          this.#baseWallTime = Date.parse(match[1]) || 0;
        } else {
          this.#baseWallTime = Date.now();
        }
      } finally {
        await handle.close();
      }
    } catch {
      this.#baseWallTime = Date.now();
    }

    try {
      this.#fsWatcher = watch(this.#filePath, () => {
        this.drain().catch(() => {});
      });
      this.#fsWatcher.on('error', () => {
        // Ignore watcher error, interval fallback continues
      });
    } catch {
      // Fallback to polling interval
    }

    this.#interval = setInterval(() => {
      this.drain().catch(() => {});
    }, 1000);
    if (typeof this.#interval?.unref === 'function') {
      this.#interval.unref();
    }

    return { alreadyRunning: false, target, filePath: this.#filePath, offset: this.#offset };
  }

  async drain() {
    if (!this.#running || !this.#filePath) return;
    if (this.#drainPromise) {
      this.#needsAnotherDrain = true;
      return this.#drainPromise;
    }

    this.#drainPromise = (async () => {
      try {
        do {
          this.#needsAnotherDrain = false;
          await this.#doDrain();
        } while (this.#needsAnotherDrain && this.#running && this.#filePath);
      } finally {
        this.#drainPromise = null;
      }
    })();

    return this.#drainPromise;
  }

  async #doDrain() {
    try {
      const s = await stat(this.#filePath);
      if (s.size <= this.#offset) {
        if (s.size < this.#offset) this.#offset = 0; // Rotated/truncated
        return;
      }
      const readLength = s.size - this.#offset;
      const chunk = Buffer.alloc(readLength);
      const handle = await open(this.#filePath, 'r');
      try {
        await handle.read(chunk, 0, readLength, this.#offset);
      } finally {
        await handle.close();
      }
      this.#offset = s.size;

      const rawChunk = chunk.toString('utf8');
      const fullText = this.#remainder + rawChunk;
      const splitLines = fullText.split(/\r?\n/);
      this.#remainder = splitLines.pop() ?? '';

      const secretsList = typeof this.#secrets === 'function' ? this.#secrets() : (Array.isArray(this.#secrets) ? this.#secrets : []);
      for (const line of splitLines) {
        const cleanLine = line.replace(/\r$/, '');
        if (!cleanLine) continue;
        const parsed = parseLogLine(cleanLine, this.#baseWallTime, secretsList);
        this.#buffer.push({
          kind: 'log',
          target: this.#target,
          ...parsed
        });
      }
    } catch {
      // Ignore transient read errors while client writes
    }
  }

  poll({ cursor = 0, limit = 100, level = null, search = null } = {}) {
    if (!this.#running) {
      throw new Error('Log watcher is not running. Call lol_logs_watch_start first.');
    }
    const wantLevel = level && level !== 'ALL' ? level.toUpperCase() : null;
    const needle = search ? String(search).toLowerCase() : null;

    const predicate = (e) => {
      if (wantLevel && e.level !== wantLevel) return false;
      if (needle && !String(e.raw ?? '').toLowerCase().includes(needle)) return false;
      return true;
    };

    const page = this.#buffer.select({ cursor, limit, predicate });
    return {
      ...page,
      running: this.#running,
      target: this.#target,
      filePath: this.#filePath
    };
  }

  async stop() {
    if (!this.#running) return { stopped: false };
    if (this.#fsWatcher) {
      this.#fsWatcher.close();
      this.#fsWatcher = null;
    }
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    this.#running = false;
    if (this.#drainPromise) {
      try {
        await this.#drainPromise;
      } catch {
        // Ignore errors from in-flight drain during stop
      }
    }
    this.#remainder = '';
    const held = this.#buffer.length;
    this.#buffer.clear();
    return { stopped: true, entriesDiscarded: held };
  }
}

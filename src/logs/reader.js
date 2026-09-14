import { open, stat } from 'node:fs/promises';
import { parseLogLine } from './parser.js';

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB chunks backwards

export class LogReader {
  #finder;
  #secrets;
  #chunkSize;

  constructor({ finder, secrets = () => [], chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
    this.#finder = finder;
    this.#secrets = secrets;
    this.#chunkSize = chunkSize;
  }

  async tail({ target = 'client', lines = 100, level = 'ALL', search = null, session = null } = {}) {
    const filePath = await this.#finder.resolveActiveLogFile(target, session);
    const fileStat = await stat(filePath);
    const totalSize = fileStat.size;

    if (totalSize === 0 || lines <= 0) {
      return {
        target,
        filePath,
        totalSize,
        returned: 0,
        entries: []
      };
    }

    const wantLevel = level && level !== 'ALL' ? level.toUpperCase() : null;
    const needle = search ? String(search).toLowerCase() : null;
    const secretsList = typeof this.#secrets === 'function' ? this.#secrets() : (Array.isArray(this.#secrets) ? this.#secrets : []);

    const handle = await open(filePath, 'r');
    try {
      let baseWallTime = 0;

      // Extract base wall time from line 1 if available
      const headBufferSize = Math.min(2048, totalSize);
      const headBuffer = Buffer.alloc(headBufferSize);
      await handle.read(headBuffer, 0, headBufferSize, 0);
      const headText = headBuffer.toString('utf8');
      const startMatch = headText.match(/Logging started at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})/);
      if (startMatch) {
        baseWallTime = Date.parse(startMatch[1]) || 0;
      }

      let position = totalSize;
      let remainderBuffer = Buffer.alloc(0);
      const collectedEntries = [];

      while (position > 0 && collectedEntries.length < lines) {
        const readSize = Math.min(this.#chunkSize, position);
        position -= readSize;
        const chunk = Buffer.alloc(readSize);
        await handle.read(chunk, 0, readSize, position);
        const combined = Buffer.concat([chunk, remainderBuffer]);

        let linesBuffer;
        if (position > 0) {
          const firstLf = combined.indexOf(0x0a);
          if (firstLf === -1) {
            remainderBuffer = combined;
            continue;
          }
          linesBuffer = combined.subarray(firstLf + 1);
          let remEnd = firstLf;
          if (remEnd > 0 && combined[remEnd - 1] === 0x0d) {
            remEnd -= 1;
          }
          remainderBuffer = combined.subarray(0, remEnd);
        } else {
          linesBuffer = combined;
          remainderBuffer = Buffer.alloc(0);
        }

        const text = linesBuffer.toString('utf8');
        const rawLines = text.split(/\r?\n/);

        for (let i = rawLines.length - 1; i >= 0; i--) {
          const rawLine = rawLines[i];
          if (!rawLine || rawLine.trim() === '') continue;
          const cleanLine = rawLine.replace(/\r$/, '');
          const parsed = parseLogLine(cleanLine, baseWallTime, secretsList);
          if (wantLevel && parsed.level !== wantLevel) continue;
          if (needle && !parsed.raw.toLowerCase().includes(needle)) continue;
          collectedEntries.push(parsed);
          if (collectedEntries.length >= lines) break;
        }
      }

      // If we reached position 0 and still have remainderBuffer that wasn't processed
      if (remainderBuffer.length > 0 && collectedEntries.length < lines) {
        const remainingText = remainderBuffer.toString('utf8');
        const remainingLines = remainingText.split(/\r?\n/);
        for (let i = remainingLines.length - 1; i >= 0; i--) {
          const rawLine = remainingLines[i];
          if (!rawLine || rawLine.trim() === '') continue;
          const cleanLine = rawLine.replace(/\r$/, '');
          const parsed = parseLogLine(cleanLine, baseWallTime, secretsList);
          if (wantLevel && parsed.level !== wantLevel) continue;
          if (needle && !parsed.raw.toLowerCase().includes(needle)) continue;
          collectedEntries.push(parsed);
          if (collectedEntries.length >= lines) break;
        }
      }

      collectedEntries.reverse();

      return {
        target,
        filePath,
        totalSize,
        returned: collectedEntries.length,
        entries: collectedEntries
      };
    } finally {
      await handle.close();
    }
  }
}

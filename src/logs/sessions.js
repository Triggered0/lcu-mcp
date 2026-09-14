import { readdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { DEFAULT_LOCKFILE_PATH } from '../lcu/lockfile.js';

export class LogSessionFinder {
  #logsDir;

  constructor({ logsDir = null, lockfilePath = DEFAULT_LOCKFILE_PATH } = {}) {
    this.#logsDir = logsDir || join(dirname(lockfilePath), 'Logs');
  }

  get logsDir() {
    return this.#logsDir;
  }

  async findSessions(target = 'client', limit = 20) {
    if (target === 'game') {
      return this.#findGameSessions(limit);
    }
    return this.#findClientSessions(target, limit);
  }

  async resolveActiveLogFile(target = 'client', sessionName = null) {
    if (sessionName) {
      const safeName = basename(sessionName);
      if (safeName === '.' || safeName === '..') {
        throw new Error(`Invalid sessionName "${sessionName}"`);
      }
      if (target === 'game') {
        const sessionPath = join(this.#logsDir, 'GameLogs', safeName);
        const files = await readdir(sessionPath).catch(() => []);
        const r3d = files.find((f) => f.endsWith('_r3dlog.txt'));
        if (!r3d) throw new Error(`No r3dlog found in session ${sessionName}`);
        return join(sessionPath, r3d);
      }
      const dir = join(this.#logsDir, 'LeagueClient Logs');
      const logPath = join(dir, safeName);
      const s = await stat(logPath).catch(() => null);
      if (!s) throw new Error(`Log file "${sessionName}" not found in ${dir}`);
      return logPath;
    }

    const sessions = await this.findSessions(target, 1);
    if (sessions.length === 0) {
      throw new Error(`No log files found for target "${target}" in ${this.#logsDir}`);
    }
    return sessions[0].path;
  }

  async #findClientSessions(target, limit) {
    const dir = join(this.#logsDir, 'LeagueClient Logs');
    const suffix = target === 'ux' ? 'LeagueClientUx.log' : 'LeagueClient.log';
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const matched = files.filter((f) => f.endsWith(suffix));
    const entries = await Promise.all(
      matched.map(async (filename) => {
        const fullPath = join(dir, filename);
        const s = await stat(fullPath).catch(() => null);
        return s ? { filename, path: fullPath, size: s.size, mtime: s.mtimeMs } : null;
      })
    );

    return entries
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime || b.filename.localeCompare(a.filename))
      .slice(0, limit);
  }

  async #findGameSessions(limit) {
    const dir = join(this.#logsDir, 'GameLogs');
    let subdirs;
    try {
      subdirs = await readdir(dir);
    } catch {
      return [];
    }

    const entries = await Promise.all(
      subdirs.map(async (subdir) => {
        const sessionDir = join(dir, subdir);
        const s = await stat(sessionDir).catch(() => null);
        if (!s || !s.isDirectory()) return null;
        const files = await readdir(sessionDir).catch(() => []);
        const r3d = files.find((f) => f.endsWith('_r3dlog.txt'));
        if (!r3d) return null;
        const logPath = join(sessionDir, r3d);
        const logStat = await stat(logPath).catch(() => null);
        return logStat
          ? { session: subdir, filename: r3d, path: logPath, size: logStat.size, mtime: logStat.mtimeMs }
          : null;
      })
    );

    return entries
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime || b.filename.localeCompare(a.filename))
      .slice(0, limit);
  }
}

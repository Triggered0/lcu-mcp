import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function getJsFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '.git') {
          files.push(...getJsFiles(full));
        }
      } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

const targets = ['bin', 'src', 'tests', 'scripts'].flatMap(getJsFiles);
let errors = 0;
for (const file of targets) {
  const res = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (res.status !== 0) errors++;
}

if (errors > 0) {
  console.error(`Syntax check failed with ${errors} error(s).`);
  process.exit(1);
}
console.log(`Syntax check passed across ${targets.length} JavaScript files.`);

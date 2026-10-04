// Temporary directories for the script tests: removed when the test process exits, so a run leaves nothing behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

export function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

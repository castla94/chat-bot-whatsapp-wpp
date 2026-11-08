const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') check(file);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}
for (const directory of ['src', 'scripts', 'test', 'integrations']) {
  if (fs.existsSync(directory)) check(directory);
}
if (!process.exitCode) console.log('Sintaxis correcta en todos los módulos.');

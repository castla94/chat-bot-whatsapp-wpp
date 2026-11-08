const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadEnv, envPath } = require('../src/env');

test('la ruta predeterminada apunta a la raíz del proyecto desde cualquier cwd', () => {
  const file = require.resolve('../src/env');
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(file)}).envPath)`], {
    cwd: os.tmpdir(), encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, path.resolve(__dirname, '../.env'));
  assert.equal(child.stdout, envPath);
});

test('carga credenciales antes de validar, completa vacíos y respeta variables externas válidas', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, 'OPENAI_API_KEY=test-key\nEMAIL_TOKEN=test-email\nPORT=3004\n');
  const environment = { OPENAI_API_KEY: '', PORT: '4000' };
  const result = loadEnv(file, environment);
  assert.equal(result.found, true);
  assert.deepEqual(environment, { OPENAI_API_KEY: 'test-key', EMAIL_TOKEN: 'test-email', PORT: '4000' });
});

test('admite variables del servidor aunque no exista .env', () => {
  const environment = { OPENAI_API_KEY: 'external-test-key' };
  const result = loadEnv(path.join(os.tmpdir(), 'wpp-nonexistent-env', '.env'), environment);
  assert.equal(result.found, false);
  assert.equal(environment.OPENAI_API_KEY, 'external-test-key');
});

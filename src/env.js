const path = require('node:path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../.env');

function loadEnv(file = envPath, environment = process.env) {
  const result = dotenv.config({ path: file, processEnv: environment });
  // Un .env es opcional si las variables ya llegan desde el servidor.
  if (result.error && result.error.code !== 'ENOENT') {
    throw new Error(`No se pudo leer el archivo de entorno ${file}: ${result.error.code || result.error.message}`);
  }
  // PM2 puede conservar variables vacías de un arranque anterior.
  // Respetar valores externos válidos y completar los vacíos desde el archivo.
  for (const [key, value] of Object.entries(result.parsed || {})) {
    if (!String(environment[key] ?? '').trim() && value.trim()) environment[key] = value;
  }
  return { envPath: file, found: !result.error };
}

module.exports = { loadEnv, envPath };

const path = require('node:path');

const session = process.env.WPP_SESSION || 'chatbot';
if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
  throw new Error('WPP_SESSION solo admite letras, números, guiones y guiones bajos.');
}

const headless = process.env.WPP_HEADLESS || 'true';
if (!['true', 'false'].includes(headless)) {
  throw new Error('WPP_HEADLESS debe ser true o false.');
}

const autoClose = Number(process.env.WPP_AUTO_CLOSE ?? 120000);
if (!Number.isSafeInteger(autoClose) || autoClose < 0) {
  throw new Error('WPP_AUTO_CLOSE debe ser un entero mayor o igual a 0.');
}

module.exports = {
  session,
  headless: headless === 'true',
  autoClose,
  folderNameToken: path.resolve(__dirname, '../bot_sessions'),
  browserPath: process.env.WPP_BROWSER_PATH || undefined,
  apiPort: readPort(process.env.API_PORT ?? (Number(process.env.PORT || 3000) + 10000)),
  apiHost: process.env.API_HOST || '0.0.0.0',
};

function readPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT (o PORT + 10000) debe ser un puerto entre 1 y 65535.');
  }
  return port;
}

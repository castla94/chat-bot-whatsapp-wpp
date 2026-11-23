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

// Flags de Chromium para servidor headless. Incluye los valores por defecto de
// WPPConnect (browserArgs reemplaza esa lista) más los ajustes de servidor:
// sin sandbox, silencioso y con el mínimo de servicios en segundo plano para
// arrancar antes y consumir menos CPU/RAM.
const browserArgs = [
  // Valores por defecto de WPPConnect
  '--log-level=3',
  '--no-default-browser-check',
  '--no-experiments',
  '--ignore-gpu-blacklist',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-default-apps',
  '--enable-features=NetworkService',
  '--disable-webgl',
  '--disable-infobars',
  '--window-position=0,0',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-in-process-stack-traces',
  '--disable-histogram-customizer',
  '--disable-gl-extensions',
  '--disable-composited-antialiasing',
  '--disable-canvas-aa',
  '--disable-3d-apis',
  '--disable-accelerated-2d-canvas',
  '--disable-accelerated-jpeg-decoding',
  '--disable-accelerated-mjpeg-decode',
  '--disable-app-list-dismiss-on-blur',
  '--disable-accelerated-video-decode',
  // No se usa --disable-dev-shm-usage: en VM dedicada /dev/shm usa RAM y es más
  // rápido que /tmp. En contenedores con /dev/shm pequeño habría que restaurarlo.
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  // Ajustes de servidor
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--memory-pressure-off',
  // Arranque: evita tareas/monitores que retrasan la carga inicial en servidor.
  '--no-first-run',
  '--disable-domain-reliability',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-software-rasterizer',
  '--disable-speech-api',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
];

module.exports = {
  session,
  headless: headless === 'true',
  autoClose,
  browserArgs,
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

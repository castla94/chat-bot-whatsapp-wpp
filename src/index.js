const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { createBusinessRuntime, loadBusiness } = require('./bot');
const { startServer } = require('./server');

let client;
let runtime;
let server;
let stopping = false;
const qrPath = path.resolve(__dirname, '../bot.qr.png');

function clearQr() {
  try {
    fs.rmSync(qrPath, { force: true });
  } catch (error) {
    console.error('No se pudo eliminar el QR anterior:', error.message);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  runtime?.stop();
  clearQr();
  console.log(`\nCerrando el bot (${signal})...`);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  try {
    if (server) server.close();
    if (client) await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Error al cerrar el cliente:', error.message || error);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main() {
  for (const key of ['OPENAI_API_KEY', 'EMAIL_TOKEN']) {
    if (!process.env[key]?.trim()) throw new Error(`Falta configurar ${key} en .env.`);
  }
  for (const directory of ['audio', 'media', 'temp']) {
    fs.mkdirSync(path.resolve(__dirname, '..', directory), { recursive: true });
  }
  const business = await loadBusiness();
  business.logger.info('Configuración activa del bot', {
    session: config.session, sessionDirectory: config.folderNameToken,
    headless: config.headless, apiHost: config.apiHost, apiPort: config.apiPort,
    silenceTextAudioSeconds: process.env.SILENCE_TEXT_AUDIO_SECONDS || '5',
    silenceImageSeconds: 45, model: 'gpt-5-mini',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    backendIdentityConfigured: Boolean(process.env.EMAIL_TOKEN),
    backendUrl: process.env.WHATSAPP_API_BASE_URL || 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV',
    cloudwatchEnabled: process.env.CLOUDWATCH_ENABLED !== 'false',
    action: 'bot_configuration',
  });
  server = await startServer(() => runtime, config);
  console.log(`API de envío disponible en el puerto ${config.apiPort}.`);
  clearQr();
  console.log('Iniciando WhatsApp. Escanea el QR desde Dispositivos vinculados.');
  client = await wppconnect.create({
    session: config.session,
    headless: config.headless,
    autoClose: config.autoClose,
    tokenStore: 'file',
    folderNameToken: config.folderNameToken,
    logQR: false,
    catchQR: (base64Qr, asciiQR, attempts) => {
      console.log(`\nQR disponible (intento ${attempts}). Escanéalo desde WhatsApp:\n${asciiQR}`);
      const image = /^data:image\/png;base64,(.+)$/s.exec(base64Qr || '');
      if (!image) {
        console.error('No se recibió una imagen PNG válida del QR. Usa el código de la terminal.');
        return;
      }
      try {
        fs.writeFileSync(qrPath, Buffer.from(image[1], 'base64'), { mode: 0o600 });
        console.log(`También puedes abrir la imagen: ${qrPath}`);
      } catch (error) {
        console.error('No se pudo guardar la imagen QR:', error.message);
      }
    },
    disableWelcome: true,
    ...(config.browserPath && {
      puppeteerOptions: { executablePath: config.browserPath },
    }),
    statusFind: (status, session) => {
      console.log(`[${session}] Estado: ${status}`);
      if (status === 'notLogged') {
        console.log('Esperando el QR de WhatsApp; puede tardar unos segundos.');
      }
      if (['qrReadSuccess', 'isLogged', 'autocloseCalled', 'browserClose'].includes(status)) {
        clearQr();
      }
    },
  });

  runtime = await createBusinessRuntime(client, business);
  runtime.attach();
  business.logger.info('Bot iniciado', { port: process.env.PORT || 3000, apiPort: config.apiPort });
  console.log('Bot conectado. Flujos de texto, audio e imágenes activos con WPPConnect.');
}

main().catch((error) => {
  clearQr();
  if (server) server.close();
  console.error('No se pudo iniciar el bot:', error.message || error);
  import('./helpers/cloudWatchLogger.js').then(({ defaultLogger }) => {
    defaultLogger.error('Error al iniciar el bot', { error: error.message, stack: error.stack });
  }).catch(() => {});
  process.exitCode = 1;
});

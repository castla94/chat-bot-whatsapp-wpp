const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mime = require('mime-types');
const { toChatId } = require('./providers/wppconnect');

function createApp(getRuntime) {
  const app = express();
  const log = (level, message, metadata) => getRuntime()?.logger?.[level]?.(message, metadata);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.get('/health', (req, res) => {
    const ready = Boolean(getRuntime());
    res.status(ready ? 200 : 503).json({ ready, provider: 'wppconnect' });
  });
  app.use((req, res, next) => {
    if (!getRuntime()) return res.status(503).json({ error: 'WhatsApp todavía no está conectado.' });
    next();
  });

  app.post('/send-message-bot', async (req, res) => {
    const { phoneNumber, message } = req.body || {};
    if (typeof phoneNumber !== 'string' || typeof message !== 'string' || !message.trim()) {
      log('warn', "Parámetros 'phoneNumber' y 'message' son requeridos", {
        phoneNumber: Boolean(phoneNumber), message: Boolean(message),
      });
      return res.status(400).json({ error: "'phoneNumber' y 'message' son requeridos." });
    }
    let id;
    try { id = toChatId(phoneNumber); } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const runtime = getRuntime();
      await runtime.provider.sendText(id, message);
      log('info', 'Mensaje Manual Enviado', {
        phoneNumber, messageBody: message, timestamp: new Date().toISOString(),
      });
      const ctx = await runtime.provider.context({ fromMe: true, to: id, id: 'api', type: 'chat' });
      await runtime.recordManual(ctx.from, message, '', '', '', { source: 'api' });
      res.json({ data: 'enviado' });
    } catch (error) {
      log('error', 'Error al enviar el mensaje', { phoneNumber, error: error.message, stack: error.stack });
      console.error('Error enviando mensaje manual:', error.message);
      res.status(500).json({ error: 'Error al enviar el mensaje.' });
    }
  });

  app.post('/send-media-bot', async (req, res) => {
    const { phoneNumber, message = '', base64Media, type } = req.body || {};
    if (typeof phoneNumber !== 'string' || typeof message !== 'string' ||
        typeof base64Media !== 'string' || !['imagen', 'file'].includes(type)) {
      log('warn', "Parámetros 'phoneNumber' , 'message' , 'base64Media', 'type' son requeridos", {
        phoneNumber: Boolean(phoneNumber), message: Boolean(message),
      });
      return res.status(400).json({ error: "Se requieren phoneNumber, base64Media y type ('imagen' o 'file')." });
    }
    let id;
    try { id = toChatId(phoneNumber); } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const match = /^data:([^;]+);base64,(.+)$/s.exec(base64Media);
    const encoded = match ? match[2] : base64Media;
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      return res.status(400).json({ error: 'base64Media no contiene base64 válido.' });
    }
    const mediaType = match?.[1] || (type === 'imagen' ? 'image/jpeg' : 'application/pdf');
    if (type === 'imagen' && !mediaType.startsWith('image/')) {
      return res.status(400).json({ error: 'El tipo MIME debe corresponder a una imagen.' });
    }
    let directory;
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-media-'));
      const file = path.join(directory, `attachment.${mime.extension(mediaType) || 'bin'}`);
      await fs.writeFile(file, Buffer.from(encoded, 'base64'), { mode: 0o600 });
      const runtime = getRuntime();
      if (type === 'imagen') await runtime.provider.sendImage(id, file, message);
      else {
        await runtime.provider.sendFile(id, file);
        if (message !== '') await runtime.provider.sendText(id, message);
      }
      log('info', type + ' Manual Enviado', {
        phoneNumber, messageBody: type + ': ' + message, timestamp: new Date().toISOString(),
      });
      const ctx = await runtime.provider.context({ fromMe: true, to: id, id: 'api', type: 'chat' });
      await runtime.recordManual(ctx.from, message, '', base64Media, type, { source: 'api' });
      res.json({ data: 'enviado' });
    } catch (error) {
      log('error', 'Error al enviar el mensaje ' + type, { phoneNumber, error: error.message, stack: error.stack });
      console.error('Error enviando archivo manual:', error.message);
      res.status(500).json({ error: 'Error al enviar el archivo.' });
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  return app;
}

function startServer(getRuntime, { apiPort, apiHost }) {
  return new Promise((resolve, reject) => {
    const server = createApp(getRuntime).listen(apiPort, apiHost, () => resolve(server));
    server.once('error', reject);
  });
}

module.exports = { createApp, startServer };

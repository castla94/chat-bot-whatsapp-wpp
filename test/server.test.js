const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createApp } = require('../src/server');

async function serve(t, runtime) {
  const server = await new Promise((resolve) => {
    const instance = createApp(() => runtime).listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return async (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

test('API informa 503 mientras WhatsApp no está conectado', async (t) => {
  const request = await serve(t, null);
  assert.equal((await request('/health')).status, 503);
  assert.equal((await request('/send-message-bot', { phoneNumber: '123', message: 'hola' })).status, 503);
});

test('API normaliza destinatarios y registra el envío manual una vez', async (t) => {
  const sent = [];
  const records = [];
  const request = await serve(t, {
    provider: { sendText: async (...args) => sent.push(args), context: async () => ({ from: '584121234567' }) },
    services: { postWhatsappConversation: async (...args) => records.push(args) },
    recordManual: async () => { throw new Error('La API debe registrar directamente en el servicio AWS.'); },
  });
  assert.equal((await request('/send-message-bot', { phoneNumber: '584121234567@s.whatsapp.net', message: 'hola' })).status, 200);
  assert.deepEqual(sent, [['584121234567@c.us', 'hola']]);
  assert.deepEqual(records, [['584121234567', '', 'hola', '', '', 'openia']]);
  assert.equal((await request('/send-message-bot', { phoneNumber: {}, message: 'hola' })).status, 400);
  assert.equal((await request('/send-message-bot', { phoneNumber: 'bad', message: 'hola' })).status, 400);
});

test('API envía medios y limpia el archivo temporal incluso si falla el envío', async (t) => {
  let file;
  let fail = false;
  const records = [];
  const request = await serve(t, {
    provider: {
      async sendImage(to, path, caption) {
        file = path;
        assert.equal(to, '584121234567@c.us');
        assert.equal(caption, 'pago');
        assert.equal(await fs.readFile(path, 'utf8'), 'test');
        if (fail) throw new Error('fallo simulado');
      },
      context: async () => ({ from: '584121234567' }),
    },
    services: { postWhatsappConversation: async (...args) => records.push(args) },
  });
  const body = { phoneNumber: '584121234567', message: 'pago', type: 'imagen', base64Media: 'data:image/png;base64,dGVzdA==' };
  assert.equal((await request('/send-media-bot', body)).status, 200);
  assert.deepEqual(records, [['584121234567', '', 'pago', body.base64Media, 'imagen', 'openia']]);
  // El bloque finally termina después de enviar la respuesta HTTP.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(fs.access(file));
  fail = true;
  assert.equal((await request('/send-media-bot', body)).status, 500);
  assert.equal(records.length, 1, 'Un envío fallido no debe registrar otra conversación.');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(fs.access(file));
  assert.equal((await request('/send-media-bot', { ...body, type: 'otro' })).status, 400);
  assert.equal((await request('/send-media-bot', { ...body, base64Media: '!!!' })).status, 400);
});

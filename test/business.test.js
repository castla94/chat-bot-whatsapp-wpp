const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadBusiness, createBusinessRuntime } = require('../src/bot');

test('flujos reales combinan texto, audio e imagen en una única respuesta WPPConnect', { timeout: 30000 }, async (t) => {
  // Ninguna credencial ni servicio externo se usa en esta prueba.
  process.env.OPENAI_API_KEY = 'test-only';
  process.env.EMAIL_TOKEN = 'test-only';
  process.env.CLOUDWATCH_ENABLED = 'false';
  process.env.LOG_TO_FILE = 'false';
  process.env.ENABLE_MODEL_CLASSIFICATION = 'false';
  process.env.SILENCE_TEXT_AUDIO_SECONDS = '0.01';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-business-'));
  const originalDirectory = process.cwd();
  process.chdir(directory);
  await fs.mkdir('audio');
  await fs.mkdir('media');
  t.after(async () => {
    process.chdir(originalDirectory);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { default: axios } = await import('axios');
  const { Completions } = await import('openai/resources/chat/completions');
  const { Transcriptions } = await import('openai/resources/audio/transcriptions');
  const requests = [];
  let globalEnabled = true;
  let whitelist = [];
  let contactEnabled = true;
  const originalAdapter = axios.defaults.adapter;
  t.after(() => { axios.defaults.adapter = originalAdapter; });
  axios.defaults.adapter = async (config) => {
    const route = new URL(config.url).pathname;
    requests.push({ route, method: config.method, data: config.data });
    let data;
    if (route.endsWith('/whatsapp-sessions-whitelist')) data = { item: { whitelist } };
    else if (route.endsWith('/whatsapp-statatus')) data = { body: JSON.stringify({ status: globalEnabled }) };
    else if (route.endsWith('/whatsapp')) data = { status: contactEnabled, name: 'Prueba' };
    else if (route.endsWith('/whatsapp-conversation')) data = { item: [] };
    else if (route.endsWith('/whatsapp-setting/credits')) data = { item: { credit: 100, premiun: true, plan: 'Pro' } };
    else if (route.endsWith('/whatsapp-prompt')) data = { prompt: 'Atiende la consulta de {customer_name}.', products_dynamic: false };
    else if (route.endsWith('/whatsapp-sessions-alarm/regex')) data = { statusCode: 404 };
    else if (route.endsWith('/whatsapp-email-vendor')) data = { statusCode: 200 };
    else throw new Error(`Ruta no simulada: ${route}`);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  const modelCalls = [];
  t.mock.method(Completions.prototype, 'create', async (body) => {
    modelCalls.push(body);
    const isVision = Array.isArray(body.messages[0].content);
    if (body.model === 'gpt-5-mini') {
      for (const parameter of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
        assert.equal(Object.hasOwn(body, parameter), false, `${parameter} no debe enviarse con gpt-5-mini`);
      }
    }
    return {
      choices: [{ message: { content: isVision ? 'Imagen de comprobante analizada' : 'Respuesta a la consulta combinada' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
  });
  const transcribe = t.mock.method(Transcriptions.prototype, 'create', async ({ file }) => {
    for await (const chunk of file) assert.ok(chunk.length > 0);
    return { text: 'Mi consulta enviada por audio' };
  });
  const business = await loadBusiness();
  business.logger.silent = true;
  t.after(() => business.logger.close());

  // Audio WAV PCM real para verificar descarga y conversión con ffmpeg.
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(3200, 40);
  const sent = [];
  const runtime = await createBusinessRuntime({
    getProfilePicFromServer: async () => ({}),
    setChatState: async () => {},
    sendSeen: async () => {},
    decryptFile: async (message) => message.type === 'ptt' ? wav : Buffer.from('image-fixture'),
    sendText: async (to, body) => { sent.push({ to, body }); return { id: `out-${sent.length}` }; },
  }, {
    ...business,
    buffer: {
      ...business.buffer,
      // Simula que ya transcurrió la ventana original de silencio de imágenes.
      addReceivedMessage: (phone, options) => business.buffer.addReceivedMessage(phone, {
        ...options, receivedAtMs: Date.now() - 50000,
      }),
    },
  });

  const base = { from: '584120000001@c.us', notifyName: 'Prueba' };
  await Promise.all([
    runtime.incoming({ ...base, type: 'chat', body: 'Necesito información del servicio' }),
    runtime.incoming({ ...base, id: 'audio-1', type: 'ptt', mimetype: 'audio/wav' }),
    runtime.incoming({ ...base, id: 'image-1', type: 'image', mimetype: 'image/png', caption: 'Adjunto mi comprobante' }),
  ]);
  assert.equal(transcribe.mock.callCount(), 1);
  assert.deepEqual(sent, [{ to: '584120000001@c.us', body: 'Respuesta a la consulta combinada' }]);
  const finalCalls = modelCalls.filter((call) => call.model === 'gpt-5-mini');
  assert.equal(finalCalls.length, 1);
  const payload = JSON.stringify(finalCalls[0].messages);
  assert.match(payload, /Necesito información del servicio/);
  assert.match(payload, /Mi consulta enviada por audio/);
  assert.match(payload, /Adjunto mi comprobante/);
  assert.match(payload, /Imagen de comprobante analizada/);
  assert.equal(business.buffer.getConversationState('584120000001').bufferCount, 0);
  assert.ok(requests.some((r) => r.route.endsWith('/whatsapp-conversation') && r.method === 'post'));
  assert.ok(requests.some((r) => r.route.endsWith('/whatsapp-setting/credits') && r.method === 'post'));

  await t.test('whitelist conserva el bloqueo original sin consultar IA', async () => {
    const previousCalls = modelCalls.length;
    const previousSent = sent.length;
    whitelist = ['584120000002'];
    await runtime.incoming({ from: '584120000002@c.us', id: 'whitelisted', type: 'chat', body: 'Consulta' });
    assert.equal(modelCalls.length, previousCalls);
    assert.equal(sent.length, previousSent);
    whitelist = [];
  });
  await t.test('estado global inactivo conserva el registro de entrada sin responder', async () => {
    globalEnabled = false;
    const previousCalls = modelCalls.length;
    const previousSent = sent.length;
    await runtime.incoming({ from: '584120000003@c.us', id: 'disabled-global', type: 'chat', body: 'Consulta global' });
    assert.equal(modelCalls.length, previousCalls);
    assert.equal(sent.length, previousSent);
    assert.ok(requests.some((r) => r.route.endsWith('/whatsapp-conversation') && r.method === 'post' && String(r.data).includes('Consulta global')));
    globalEnabled = true;
  });
  await t.test('contacto inactivo conserva el registro de entrada sin responder', async () => {
    contactEnabled = false;
    const previousCalls = modelCalls.length;
    const previousSent = sent.length;
    await runtime.incoming({ from: '584120000004@c.us', id: 'disabled-contact', type: 'chat', body: 'Consulta contacto' });
    assert.equal(modelCalls.length, previousCalls);
    assert.equal(sent.length, previousSent);
    assert.ok(requests.some((r) => r.route.endsWith('/whatsapp-conversation') && r.method === 'post' && String(r.data).includes('Consulta contacto')));
    contactEnabled = true;
  });
});

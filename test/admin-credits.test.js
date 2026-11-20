const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_NO_CREDITS_MESSAGE = "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";

// Reproduce el escenario admin con créditos en 0 y verifica que:
//   1) NO se envía el mensaje por defecto de "sin créditos"
//   2) se recargan 1000 créditos
//   3) SÍ se envía la respuesta generada por OpenAI
test('admin con créditos en 0 recarga 1000 y responde por OpenAI', { timeout: 30000 }, async (t) => {
  process.env.OPENAI_API_KEY = 'test-only';
  process.env.EMAIL_TOKEN = 'admin@telknec.cl';
  process.env.CLOUDWATCH_ENABLED = 'false';
  process.env.LOG_TO_FILE = 'false';
  process.env.ENABLE_MODEL_CLASSIFICATION = 'false';
  process.env.SILENCE_TEXT_AUDIO_SECONDS = '0.01';

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-admin-credits-'));
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

  const requests = [];
  const originalAdapter = axios.defaults.adapter;
  t.after(() => { axios.defaults.adapter = originalAdapter; });
  axios.defaults.adapter = async (config) => {
    const route = new URL(config.url).pathname;
    requests.push({ route, method: config.method, data: config.data });
    let data;
    if (route.endsWith('/whatsapp-sessions-whitelist')) data = { item: { whitelist: [] } };
    else if (route.endsWith('/whatsapp-statatus')) data = { body: JSON.stringify({ status: true }) };
    else if (route.endsWith('/whatsapp')) data = { status: true, name: 'Prueba' };
    else if (route.endsWith('/whatsapp-conversation')) data = { item: [] };
    else if (route.endsWith('/whatsapp-setting/credits')) data = { item: { credit: 0, premiun: true, plan: 'Pro' } };
    else if (route.endsWith('/whatsapp-prompt')) data = { prompt: 'Atiende la consulta de {customer_name}.', products_dynamic: false };
    else if (route.endsWith('/whatsapp-sessions-alarm/regex')) data = { statusCode: 404 };
    else if (route.endsWith('/whatsapp-email-vendor')) data = { statusCode: 200 };
    else throw new Error(`Ruta no simulada: ${route}`);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };

  const modelCalls = [];
  t.mock.method(Completions.prototype, 'create', async (body) => {
    modelCalls.push(body);
    return {
      choices: [{ message: { content: 'Respuesta generada por OpenAI' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
  });

  const { loadBusiness, createBusinessRuntime } = require('../src/bot');
  const business = await loadBusiness();
  business.logger.silent = true;
  t.after(() => business.logger.close());

  const sent = [];
  const runtime = await createBusinessRuntime({
    getProfilePicFromServer: async () => ({}),
    setChatState: async () => {},
    sendSeen: async () => {},
    sendText: async (to, body) => { sent.push({ to, body }); return { id: `out-${sent.length}` }; },
  }, business);

  await runtime.incoming({ from: '584120000099@c.us', id: 'admin-1', type: 'chat', body: 'Necesito información' });

  // 1) El mensaje por defecto de "sin créditos" NO debe enviarse.
  assert.ok(!sent.some((m) => m.body === DEFAULT_NO_CREDITS_MESSAGE), 'No debe enviarse el mensaje por defecto de sin créditos');
  // 2) Sí debe llamarse a OpenAI.
  assert.ok(modelCalls.length >= 1, 'Debe llamarse a OpenAI');
  // 3) Sí debe enviarse la respuesta del modelo.
  assert.deepEqual(sent, [{ to: '584120000099@c.us', body: 'Respuesta generada por OpenAI' }]);
  // 4) Debe recargarse 1000 créditos.
  const refill = requests.find((r) => r.method === 'post' && r.route.endsWith('/whatsapp-setting/credits'));
  assert.ok(refill, 'Debe llamarse al POST de créditos');
  assert.equal(Number(JSON.parse(refill.data).credit), 1000, 'El POST de créditos debe recargar 1000');
});

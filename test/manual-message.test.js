const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessRuntime } = require('../src/bot');

process.env.OPENAI_API_KEY = 'test-only';
process.env.EMAIL_TOKEN = 'test-manual';
process.env.CLOUDWATCH_ENABLED = 'false';
process.env.LOG_TO_FILE = 'false';

async function setup(t, { user = { name: 'Cliente', status: true }, whitelist = [] } = {}) {
  const { default: axios } = await import('axios');
  const aws = await import('../src/services/aws/index.js');
  const calls = [];
  const logs = [];
  const oldAdapter = axios.defaults.adapter;
  t.after(() => { axios.defaults.adapter = oldAdapter; });
  axios.defaults.adapter = async (config) => {
    const route = new URL(config.url).pathname.split('/').at(-1);
    const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    calls.push({ route, method: config.method, params: config.params, data });
    let response;
    if (route === 'whatsapp' && config.method === 'get') response = user;
    else if (route === 'whatsapp' && config.method === 'post') response = { saved: true };
    else if (route === 'whatsapp-sessions-whitelist') response = { item: { whitelist } };
    else if (route === 'whatsapp-conversation') response = { saved: true };
    else throw new Error('Endpoint inesperado: ' + route);
    return { data: response, status: 200, statusText: 'OK', headers: {}, config };
  };
  const listeners = {};
  const client = {
    getWid: async () => '111@c.us',
    getPnLidEntry: async (id) => id === '111@c.us'
      ? { phoneNumber: { _serialized: '111@c.us' } }
      : { phoneNumber: { _serialized: '584121234567@c.us' } },
    onMessage: (fn) => { listeners.incoming = fn; },
    onAnyMessage: (fn) => { listeners.any = fn; },
    sendText: async () => ({}),
  };
  const runtime = await createBusinessRuntime(client, {
    flows: {}, buffer: {}, aws,
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level,
      (message, metadata) => logs.push({ level, message, ...metadata }),
    ])),
  });
  runtime.attach();
  return { calls, logs, runtime, client, listeners };
}

const manual = { from: '111@c.us', to: '12345@lid', type: 'chat', body: '  Te atiendo personalmente  ', notifyName: 'Asesor' };

test('texto manual sin ID/fromMe se detecta en onAnyMessage y llama los endpoints originales', async (t) => {
  const { listeners, calls, logs } = await setup(t);
  await listeners.any(manual);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), [
    'get whatsapp', 'post whatsapp', 'get whatsapp-sessions-whitelist', 'post whatsapp-conversation',
  ]);
  assert.equal(calls[0].params.number, '584121234567');
  assert.deepEqual(calls[1].data, { email: 'test-manual', name: 'Cliente', number: '584121234567', status: false });
  assert.deepEqual(calls[3].data, {
    phone: '584121234567', message_user: '', message_openia: 'Te atiendo personalmente',
    imageBase64: '', type: '', type_user: 'openia',
  });
  assert.deepEqual(logs.filter((log) => log.action?.startsWith('own_message_')).map((log) => log.message), [
    'Mensaje manual detectado', 'Estado del contacto para mensaje manual: activo', 'Bot desactivado por mensaje manual',
  ]);
});

test('contacto sin registro conserva el comportamiento original: sin desactivar ni guardar', async (t) => {
  const { listeners, calls, logs, runtime } = await setup(t, { user: null });
  await listeners.any({ ...manual });
  assert.equal(calls.length, 1);
  assert.equal(runtime.provider.paused.size, 0);
  assert.ok(logs.some((log) => log.action === 'own_message_skip_without_user_record'));
});

test('contacto inactivo registra el texto manual sin repetir la desactivación', async (t) => {
  const { listeners, calls, logs } = await setup(t, { user: { name: 'Cliente', status: false } });
  await listeners.any({ ...manual, fromMe: true, id: 'inactive' });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), [
    'get whatsapp', 'get whatsapp-sessions-whitelist', 'post whatsapp-conversation',
  ]);
  assert.ok(logs.some((log) => log.message === 'Estado del contacto para mensaje manual: inactivo'));
});

test('whitelist se valida después de desactivar y evita guardar conversación manual', async (t) => {
  const { listeners, calls, logs } = await setup(t, { whitelist: ['584121234567'] });
  await listeners.any({ ...manual, fromMe: true, id: 'white' });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), [
    'get whatsapp', 'post whatsapp', 'get whatsapp-sessions-whitelist',
  ]);
  assert.ok(logs.some((log) => log.action === 'own_message_skip_conversation_whitelist'));
});

test('el mismo mensaje manual con ID no llama el endpoint dos veces', async (t) => {
  const { listeners, calls } = await setup(t);
  await listeners.any({ ...manual, id: 'same' });
  await listeners.any({ ...manual, id: 'same' });
  assert.equal(calls.filter((call) => call.route === 'whatsapp-conversation').length, 1);
});

test('eco automático sin ID después de sendText no desactiva al contacto; el siguiente manual sí', async (t) => {
  const { listeners, calls, runtime } = await setup(t);
  await runtime.provider.context({ from: '12345@lid', id: 'contact', type: 'chat' });
  await runtime.provider.sendMessage('584121234567', 'Respuesta automática');
  const echo = { ...manual, body: 'Respuesta automática' };
  await listeners.any(echo);
  await listeners.any(echo);
  assert.equal(calls.length, 0);
  await listeners.any({ ...echo, id: 'human-repeat' });
  assert.equal(calls.filter((call) => call.route === 'whatsapp-conversation').length, 1);
});

test('API conserva la lógica original: registra el envío sin cambiar estado ni consultar whitelist', async (t) => {
  const { runtime, calls } = await setup(t);
  await runtime.recordManual('584121234567', 'Envío API', '', '', '', { source: 'api' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, 'whatsapp-conversation');
  assert.equal(calls[0].data.type_user, 'openia');
  assert.equal(runtime.provider.paused.size, 0);
});

test('grupos, historial y mensajes de otros usuarios no activan el proceso manual', async (t) => {
  const { runtime, calls } = await setup(t);
  await runtime.own({ ...manual, fromMe: false });
  await runtime.own({ ...manual, fromMe: true, isGroupMsg: true });
  await runtime.own({ ...manual, fromMe: true, isMdHistoryMsg: true });
  await runtime.own({ ...manual, fromMe: true, body: '' });
  assert.equal(calls.length, 0);
});

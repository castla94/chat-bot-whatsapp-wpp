const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WppProvider, toChatId } = require('../src/providers/wppconnect');
const { createBusinessRuntime } = require('../src/bot');

test('normaliza teléfonos y JID antiguos a direcciones WPPConnect', () => {
  assert.equal(toChatId('+58 (412) 123-4567'), '584121234567@c.us');
  assert.equal(toChatId('584121234567@s.whatsapp.net'), '584121234567@c.us');
  assert.equal(toChatId('12345@lid'), '12345@lid');
  assert.throws(() => toChatId(''), /inválido/);
  assert.throws(() => toChatId('status@broadcast'), /inválido/);
});

test('resuelve LID a teléfono real y conserva LID para responder', async () => {
  const calls = [];
  const provider = new WppProvider({
    getPnLidEntry: async () => ({ phoneNumber: { _serialized: '584121234567@c.us' } }),
    sendText: async (...args) => { calls.push(args); return { id: 'sent' }; },
  });
  const ctx = await provider.context({ from: '12345@lid', type: 'chat', id: 'in', body: 'hola' });
  assert.equal(ctx.from, '584121234567');
  assert.equal(ctx.key.remoteJid, '12345@lid');
  await provider.sendMessage(ctx.from, 'respuesta');
  assert.deepEqual(calls, [['12345@lid', 'respuesta']]);
  assert.equal(provider.isAutomated({ id: 'sent', to: '12345@lid', type: 'chat' }), true);
});

test('no usa un LID como número telefónico cuando no existe mapeo', async () => {
  const provider = new WppProvider({ getPnLidEntry: async () => ({}) });
  await assert.rejects(provider.context({ from: '12345@lid', id: 'in' }), /número telefónico/);
});

test('descarga medios descifrados con nombres únicos y conserva captions', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = new WppProvider({ decryptFile: async () => Buffer.from('media') });
  const message = { from: '584121234567@c.us', type: 'image', id: 'img', mimetype: 'image/png', caption: 'comprobante' };
  const ctx = await provider.context(message);
  assert.equal(ctx.message.imageMessage.caption, 'comprobante');
  const first = await provider.saveFile(ctx, { path: directory });
  const second = await provider.saveFile(ctx, { path: directory });
  assert.notEqual(first, second);
  assert.equal(path.extname(first), '.png');
  assert.equal(await fs.readFile(first, 'utf8'), 'media');
});

test('distingue el evento propio durante el envío de un mensaje manual posterior', async () => {
  let provider;
  let during;
  provider = new WppProvider({ sendText: async (to, body) => {
    during = provider.isAutomated({ to, body, type: 'chat', id: 'automatic' });
    return { id: 'automatic' };
  } });
  await provider.sendMessage('584121234567', 'respuesta');
  assert.equal(during, true);
  assert.equal(provider.isAutomated({ to: '584121234567@c.us', body: 'respuesta', type: 'chat', id: 'manual' }), false);
});

function fixtures(flows = {}) {
  const entries = [];
  const updates = [];
  const conversations = [];
  return {
    entries, updates, conversations,
    dependencies: {
      flows,
      buffer: { addReceivedMessage(phone, entry) { entries.push({ phone, ...entry }); return { version: entries.length }; } },
      aws: {
        getWhatsapp: async () => ({ name: 'Cliente', status: true }),
        putWhatsapp: async (...args) => updates.push(args),
        getWhatsappWhitelist: async () => false,
        postWhatsappConversation: async (...args) => conversations.push(args),
      },
      logger: { info() {}, error() {} },
    },
  };
}

test('registra texto/audio/imagen antes de los flujos e ignora ruido y duplicados', async () => {
  const calls = [];
  const f = fixtures();
  const flow = async (ctx) => {
    assert.equal(f.entries.at(-1).messageId, ctx.key.id);
    calls.push(ctx.key.id);
  };
  f.dependencies.flows = { chat: flow, ptt: flow, audio: flow, image: flow };
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const base = { from: '584121234567@c.us', type: 'chat', body: 'consulta' };
  for (const message of [
    { id: 'text', ...base }, { id: 'text', ...base },
    { ...base, id: 'voice', type: 'ptt' }, { ...base, id: 'img', type: 'image', caption: 'pago' },
    { ...base, id: 'group', isGroupMsg: true }, { ...base, id: 'own', fromMe: true },
    { ...base, id: 'history', isMdHistoryMsg: true }, { ...base, id: 'notice', isNotification: true },
    { ...base, id: 'broadcast', from: 'status@broadcast' }, { ...base, id: 'sticker', type: 'sticker' },
  ]) await runtime.incoming(message);
  assert.deepEqual(calls, ['text', 'voice', 'img']);
  assert.deepEqual(f.entries.map((e) => e.type), ['text', 'audio', 'image']);
  assert.equal(f.entries[2].caption, 'pago');
});

test('procesa mensajes consecutivos sin bloquear el registro del segundo', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = fixtures();
  f.dependencies.flows.chat = async (ctx, { state }) => {
    await state.update({ conversationVersion: ctx.key.id });
    if (ctx.key.id === 'first') await waiting;
    else release();
    assert.equal(state.getMyState().conversationVersion, ctx.key.id);
  };
  const runtime = await createBusinessRuntime({}, f.dependencies);
  await Promise.all(['first', 'second'].map((id) => runtime.incoming({
    from: '584121234567@c.us', id, type: 'chat', body: id,
  })));
  assert.equal(f.entries.length, 2);
});

test('un mensaje manual pausa al contacto y no duplica su registro', async () => {
  const f = fixtures();
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const message = { fromMe: true, from: '111@c.us', to: '584121234567@c.us', id: 'manual', type: 'chat', body: 'Te atiendo yo' };
  await runtime.own(message);
  await runtime.own(message);
  assert.deepEqual(f.updates, [['584121234567', 'Cliente', false]]);
  assert.equal(f.conversations.length, 1);
  await assert.rejects(runtime.provider.sendMessage('584121234567', 'respuesta tardía'), /pausado/);
});

test('las respuestas del bot no desactivan al contacto', async () => {
  const f = fixtures();
  const runtime = await createBusinessRuntime({ sendText: async () => ({ id: 'bot-reply' }) }, f.dependencies);
  await runtime.provider.sendMessage('584121234567', 'respuesta');
  await runtime.own({ fromMe: true, to: '584121234567@c.us', id: 'bot-reply', type: 'chat', body: 'respuesta' });
  assert.equal(f.updates.length, 0);
  assert.equal(f.conversations.length, 0);
});

test('registra contacto identificado y omite los logs de recepción y descarte solicitados', async () => {
  const f = fixtures({ chat: async () => {} });
  const logs = [];
  f.dependencies.logger.info = (message, metadata) => logs.push({ message, ...metadata });
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const message = { id: 'diagnostic', from: '584121234567@c.us', type: 'chat', body: 'consulta IA' };
  await runtime.incoming(message);
  assert.ok(logs.some((entry) => entry.action === 'wpp_contact_resolved' && entry.messageBody === 'consulta IA'));
  assert.ok(logs.some((entry) => entry.action === 'wpp_contact_resolved' && entry.numberPhone === '584121234567'));
  await runtime.incoming({ ...message, id: 'old', isMdHistoryMsg: true });
  assert.equal(f.entries.length, 1);
  assert.equal(logs.some((entry) => ['whatsapp_raw_message', 'wpp_message_skipped', 'wpp_message_received'].includes(entry.action)), false);
});

test('recibe desde onAnyMessage si onMessage no llega y evita procesar ambos dos veces', async () => {
  const handlers = {};
  let processed = 0;
  const f = fixtures({ chat: async () => { processed++; } });
  const runtime = await createBusinessRuntime({
    onMessage: (fn) => { handlers.onMessage = fn; },
    onAnyMessage: (fn) => { handlers.onAnyMessage = fn; },
  }, f.dependencies);
  runtime.attach();
  const message = { id: 'fallback', from: '584121234567@c.us', type: 'chat', body: 'hola' };
  await handlers.onAnyMessage(message);
  await handlers.onMessage(message);
  assert.equal(processed, 1);
});

test('genera ID para mensajes sin ID y sigue aceptando IDs nativos anidados', async () => {
  let processed = 0;
  const logs = [];
  const f = fixtures({ chat: async () => { processed++; } });
  f.dependencies.logger.info = (message, metadata) => logs.push(metadata);
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const base = { from: '584121234567@c.us', type: 'chat', body: 'Hola' };
  await runtime.incoming(base);
  await runtime.incoming({ ...base, id: { id: 'nested-id' } });
  await runtime.incoming({ ...base, id: { id: 'nested-id' } });
  assert.equal(processed, 2);
  assert.ok(logs.some((entry) => entry.messageIdSource === 'generated' && entry.messageId.startsWith('generated-')));
  assert.equal(f.entries.filter((entry) => entry.messageId === 'nested-id').length, 1);
});

test('el mismo mensaje sin ID recibido por dos listeners llega una sola vez al flujo', async () => {
  const f = fixtures({ chat: async () => {} });
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const message = { from: '584121234567@c.us', type: 'chat', body: 'Hola', timestamp: 100 };
  await runtime.incoming({ ...message }, 'onMessage');
  await runtime.incoming({ ...message }, 'onAnyMessage');
  assert.equal(f.entries.length, 1);
  assert.match(f.entries[0].messageId, /^generated-/);
});

test('dos textos idénticos sin ID ni timestamp se procesan como mensajes distintos', async () => {
  const f = fixtures({ chat: async () => {} });
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const message = { from: '584121234567@c.us', type: 'chat', body: 'Hola' };
  await runtime.incoming({ ...message }, 'onAnyMessage');
  await runtime.incoming({ ...message }, 'onAnyMessage');
  await runtime.incoming({ ...message }, 'onMessage');
  await runtime.incoming({ ...message }, 'onMessage');
  assert.equal(f.entries.length, 2);
  assert.notEqual(f.entries[0].messageId, f.entries[1].messageId);
});

test('mensaje LID sin ID llega al flujo con teléfono e identificador generado', async () => {
  let received;
  const f = fixtures({ chat: async (ctx) => { received = ctx; } });
  const runtime = await createBusinessRuntime({
    getPnLidEntry: async () => ({ phoneNumber: { _serialized: '584121234567@c.us' } }),
  }, f.dependencies);
  await runtime.incoming({ from: '133861715513492@lid', to: '111@c.us', type: 'chat', body: 'Hola' });
  assert.equal(received.from, '584121234567');
  assert.match(received.key.id, /^generated-/);
  assert.equal(received.key.id, f.entries[0].messageId);
});

test('compartir el objeto entre listeners no descarta otro texto idéntico posterior', async () => {
  const f = fixtures({ chat: async () => {} });
  const runtime = await createBusinessRuntime({}, f.dependencies);
  const message = { from: '584121234567@c.us', type: 'chat', body: 'Hola' };
  await runtime.incoming(message, 'onMessage');
  await runtime.incoming(message, 'onAnyMessage');
  await runtime.incoming({ ...message }, 'onAnyMessage');
  await runtime.incoming({ ...message }, 'onMessage');
  assert.equal(f.entries.length, 2);
});

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const mime = require('mime-types');

function serializedId(value) {
  return typeof value === 'string' ? value : value?._serialized || '';
}

function getMessageId(message) {
  for (const candidate of [message?.id, message?.key?.id, message?.__x_id, message?.appMessageId]) {
    const id = serializedId(candidate) || (typeof candidate?.id === 'string' ? candidate.id : '');
    if (id.trim()) return id.trim();
  }
  return '';
}

function toChatId(value) {
  const id = serializedId(value).trim();
  if (/^\d+@(c\.us|lid|g\.us)$/.test(id)) return id;
  if (/^\d+@s\.whatsapp\.net$/.test(id)) return id.replace('@s.whatsapp.net', '@c.us');
  if (/^[+\d\s()-]+$/.test(id) && /\d/.test(id)) return `${id.replace(/\D/g, '')}@c.us`;
  throw new Error('Número o identificador de WhatsApp inválido. Usa el código de país.');
}

class WppProvider {
  constructor(client, logger = { info() {}, error() {} }) {
    this.client = client;
    this.logger = logger;
    this.addresses = new Map();
    this.sentIds = new Map();
    this.pendingSends = new Set();
    this.paused = new Set();
    this.generatedIds = new Map();
    this.generatedForMessage = new WeakMap();
    this.hostIds = new Set();
    this.recentSends = new Set();
    this.automatedEvents = new WeakSet();
    this.normalizedMessages = new WeakMap();
    // Interfaz usada por los flujos migrados; todas las operaciones son WPPConnect.
    this.vendor = {
      readMessages: async (keys) => {
        for (const id of new Set(keys.map((key) => this.resolve(key.remoteJid)))) {
          await client.sendSeen(id);
        }
      },
      sendPresenceUpdate: (state, id) => client.setChatState(
        this.resolve(id), { composing: 0, recording: 1, paused: 2 }[state] ?? 2,
      ),
      profilePictureUrl: async (id) => {
        const picture = await client.getProfilePicFromServer(this.resolve(id));
        return picture?.eurl || picture?.imgFull || picture?.img || null;
      },
    };
  }

  resolve(value) {
    const id = toChatId(value);
    return this.addresses.get(id.split('@')[0]) || id;
  }

  async initialize() {
    if (!this.client.getWid) return;
    try {
      const host = toChatId(await this.client.getWid());
      this.hostIds.add(host);
      if (this.client.getPnLidEntry) {
        const entry = await this.client.getPnLidEntry(host);
        for (const value of [entry?.lid, entry?.phoneNumber]) {
          const id = serializedId(value);
          if (id) this.hostIds.add(toChatId(id));
        }
      }
    } catch (error) {
      this.logger.info('No se pudo completar la identificación del WhatsApp vinculado', {
        error: error.message, action: 'wpp_host_identity_unavailable',
      });
    }
  }

  isOwnMessage(message) {
    for (const flag of [message.fromMe, message.isSentByMe, message.id?.fromMe, message.key?.fromMe]) {
      if (typeof flag === 'boolean') return flag;
    }
    if (message.self === 'out') return true;
    if (message.self === 'in') return false;
    const id = getMessageId(message);
    if (id.startsWith('true_')) return true;
    if (id.startsWith('false_')) return false;
    const from = serializedId(message.from).replace('@s.whatsapp.net', '@c.us');
    return this.hostIds.has(from);
  }

  normalizeMessage(message) {
    if (typeof message.fromMe === 'boolean') return message;
    if (!this.normalizedMessages.has(message)) {
      this.normalizedMessages.set(message, { ...message, fromMe: this.isOwnMessage(message) });
    }
    return this.normalizedMessages.get(message);
  }

  ensureMessageId(message, eventSource) {
    if (getMessageId(message)) return message;
    const cached = this.generatedForMessage.get(message);
    if (cached) {
      cached.sources.add(eventSource);
      return { ...message, appMessageId: cached.id };
    }
    const now = Date.now();
    // Dos listeners pueden recibir copias del mismo evento. Emparejar por origen
    // evita confundir dos mensajes legítimos iguales (p. ej. dos "Hola" seguidos).
    const cutoff = now - 2000;
    for (const [key, entries] of this.generatedIds) {
      const recent = entries.filter((entry) => entry.createdAt >= cutoff);
      if (recent.length) this.generatedIds.set(key, recent);
      else this.generatedIds.delete(key);
    }
    const timestamp = Number(message.timestamp || message.t) || null;
    const fingerprint = createHash('sha256').update(JSON.stringify([
      serializedId(message.from), serializedId(message.to), Boolean(message.fromMe),
      message.type, timestamp, message.body || '', message.caption || '',
      message.filehash || '', message.size || null,
    ])).digest('hex');
    const entries = this.generatedIds.get(fingerprint) || [];
    let entry = entries.find((candidate) => !candidate.sources.has(eventSource));
    if (!entry) {
      entry = { id: `generated-${randomUUID()}`, createdAt: now, sources: new Set() };
      entries.push(entry);
      this.generatedIds.set(fingerprint, entries);
    }
    entry.sources.add(eventSource);
    this.generatedForMessage.set(message, entry);
    // No reemplazar el ID nativo: el original se conserva para descifrar medios.
    return { ...message, appMessageId: entry.id };
  }

  async context(message) {
    const chatId = toChatId(message.fromMe ? message.to : message.from);
    let phoneId = chatId;
    if (chatId.endsWith('@lid')) {
      const mapping = await this.client.getPnLidEntry(chatId);
      phoneId = serializedId(mapping?.phoneNumber);
      if (!/^\d+@c\.us$/.test(phoneId)) {
        throw new Error('WhatsApp no entregó el número telefónico del contacto LID.');
      }
    }
    const phone = phoneId.split('@')[0];
    this.addresses.set(phone, chatId);
    const id = getMessageId(message);
    if (!id) throw new Error('Mensaje sin identificador de WhatsApp.');
    return {
      from: phone,
      host: phone,
      pushName: message.sender?.pushname || message.notifyName || message.sender?.name || '',
      body: message.type === 'chat' ? String(message.body || '') : '',
      caption: message.caption || '',
      key: { id, remoteJid: chatId, remoteJidAlt: phoneId, fromMe: Boolean(message.fromMe) },
      messageTimestamp: message.timestamp || message.t || Math.floor(Date.now() / 1000),
      message: message.type === 'image' ? { imageMessage: { caption: message.caption || '' } } : {},
      wppMessage: message,
    };
  }

  pruneSent() {
    const cutoff = Date.now() - 120000;
    for (const [id, time] of this.sentIds) if (time < cutoff) this.sentIds.delete(id);
    for (const pending of this.pendingSends) if (pending.time < cutoff) this.pendingSends.delete(pending);
    for (const sent of this.recentSends) if (sent.completedAt < Date.now() - 5000) this.recentSends.delete(sent);
  }

  isAutomated(message) {
    if (this.automatedEvents.has(message)) return true;
    this.pruneSent();
    const id = getMessageId(message);
    if (this.sentIds.has(id)) return true;
    const to = this.resolve(message.to);
    for (const pending of this.pendingSends) {
      if (this.resolve(pending.to) === to && pending.type === message.type &&
          (message.type !== 'chat' || pending.body === message.body)) {
        if (id) this.sentIds.set(id, Date.now());
        pending.observed = true;
        this.automatedEvents.add(message);
        return true;
      }
    }
    // Algunos eventos propios llegan después de resolver sendText y sin ID.
    // Consumir solo un eco por envío; no ocultar un mensaje manual posterior igual.
    for (const sent of this.recentSends) {
      if (!sent.observed && (!id || !sent.id) && this.resolve(sent.to) === to && sent.type === message.type &&
          (message.type !== 'chat' || sent.body === message.body)) {
        sent.observed = true;
        if (id) this.sentIds.set(id, Date.now());
        this.automatedEvents.add(message);
        return true;
      }
    }
    return false;
  }

  async send(to, type, body, action) {
    this.pruneSent();
    const pending = { to: this.resolve(to), type, body, time: Date.now() };
    this.pendingSends.add(pending);
    this.logger.info('enviando respuesta', {
      to: pending.to, type, messageBody: body, action: 'wpp_send_start',
    });
    try {
      const result = await action(pending.to);
      const id = getMessageId(result);
      if (id) this.sentIds.set(id, Date.now());
      this.recentSends.add({ ...pending, id, completedAt: Date.now() });
      this.logger.info('respuesta enviada', {
        to: pending.to, type, messageId: id, action: 'wpp_send_success',
      });
      return result;
    } catch (error) {
      this.logger.error('no se pudo enviar la respuesta', {
        to: pending.to, type, error: error.message, action: 'wpp_send_error',
      });
      throw error;
    } finally {
      this.pendingSends.delete(pending);
    }
  }

  sendText(to, text) {
    return this.send(to, 'chat', text, (id) => this.client.sendText(id, text));
  }

  sendImage(to, file, caption = '') {
    return this.send(to, 'image', caption, (id) => this.client.sendImage(id, file, path.basename(file), caption));
  }

  sendFile(to, file, caption = '') {
    return this.send(to, 'document', caption, (id) => this.client.sendFile(id, file, {
      filename: path.basename(file), caption,
    }));
  }

  async sendMessage(to, text, { media = null } = {}) {
    if (this.paused.has(this.resolve(to))) throw new Error('Contacto pausado por intervención manual.');
    if (!media) return this.sendText(to, text);
    const pathname = /^https?:\/\//i.test(media) ? new URL(media).pathname : media;
    const type = mime.lookup(pathname);
    if (type && type.startsWith('image/')) return this.sendImage(to, media, text);
    return this.sendFile(to, media, text);
  }

  async saveFile(ctx, { path: directory }) {
    const buffer = await this.client.decryptFile(ctx.wppMessage);
    const type = String(ctx.wppMessage.mimetype || '').split(';')[0];
    const extension = mime.extension(type) || (ctx.wppMessage.type === 'image' ? 'jpg' : 'ogg');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}.${extension}`);
    await fs.writeFile(file, buffer, { mode: 0o600 });
    return file;
  }
}

module.exports = { WppProvider, toChatId, getMessageId };

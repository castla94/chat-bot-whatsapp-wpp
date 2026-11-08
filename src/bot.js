const { WppProvider, getMessageId } = require('./providers/wppconnect');

async function loadBusiness() {
  const [text, audio, image, buffer, aws, logger, diagnostics] = await Promise.all([
    import('./flow/chatbot.js'), import('./flow/voice.js'), import('./flow/media.js'),
    import('./helpers/conversationBuffer.js'), import('./services/aws/index.js'),
    import('./helpers/cloudWatchLogger.js'),
    import('./helpers/whatsappDiagnostics.js'),
  ]);
  return {
    flows: { chat: text.chatbot, ptt: audio.voice, audio: audio.voice, image: image.media },
    buffer, aws, logger: logger.defaultLogger,
    attachDiagnostics: diagnostics.attachWhatsappDiagnostics,
  };
}

async function createBusinessRuntime(client, dependencies) {
  const { flows, buffer, aws, logger, attachDiagnostics } = dependencies || await loadBusiness();
  const provider = new WppProvider(client, logger);
  await provider.initialize();
  const states = new Map();
  const seen = new Map();
  const active = new Set();
  const subscriptions = [];
  let stopped = false;

  function once(message) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, time] of seen) if (time < cutoff) seen.delete(id);
    const id = getMessageId(message);
    if (!id || seen.has(id)) return false;
    seen.set(id, Date.now());
    return true;
  }

  async function recordManual(phoneNumber, text, name = '', media = '', type = '', { source = 'device', ctx } = {}) {
    // El endpoint original registra siempre el envío de la API; la intervención
    // desde el celular tiene sus propias validaciones y desactiva al contacto.
    if (source === 'api') {
      return aws.postWhatsappConversation(phoneNumber, '', text, media, type, 'openia');
    }
    const metadata = {
      phoneNumber, name, remoteJid: ctx?.key.remoteJid,
      remoteJidAlt: ctx?.key.remoteJidAlt, file: 'app.js',
    };
    logger.info('Mensaje manual detectado', { ...metadata, text, action: 'own_message_detected' });
    const userStatus = await aws.getWhatsapp(phoneNumber, { name });
    const label = userStatus ? (userStatus.status ? 'activo' : 'inactivo') : 'sin_registro';
    logger.info(`Estado del contacto para mensaje manual: ${label}`, {
      ...metadata, userStatus, action: 'own_message_user_status_check',
    });
    if (label === 'sin_registro') {
      logger.info('Mensaje manual omitido por contacto sin registro', {
        ...metadata, action: 'own_message_skip_without_user_record',
      });
      return;
    }
    provider.paused.add(provider.resolve(phoneNumber));
    if (userStatus.status) {
      await aws.putWhatsapp(phoneNumber, userStatus.name || name, false);
      logger.info('Bot desactivado por mensaje manual', {
        ...metadata, name: userStatus.name || name, action: 'own_message_bot_disabled',
      });
    }
    if (await aws.getWhatsappWhitelist(phoneNumber)) {
      logger.info('Conversación manual omitida por whitelist', {
        ...metadata, action: 'own_message_skip_conversation_whitelist',
      });
      return;
    }
    return aws.postWhatsappConversation(phoneNumber, '', text, '', '', 'openia');
  }

  async function incoming(message, eventSource = 'onMessage') {
    message = provider.normalizeMessage(message);
    message = provider.ensureMessageId(message, eventSource);
    const details = {
      messageId: getMessageId(message) || null,
      messageIdSource: message.appMessageId ? 'generated' : 'whatsapp',
      from: message.from, to: message.to, type: message.type,
      name: message.sender?.pushname || message.notifyName || '',
      messageBody: message.type === 'chat' ? message.body : undefined,
      caption: message.caption || '', eventSource,
    };
    const reason = stopped ? 'bot_detenido'
      : message.fromMe ? 'mensaje_propio'
      : message.isGroupMsg || /@g\.us$/.test(message.from || '') ? 'grupo'
      : message.isNotification ? 'notificacion'
      : message.isMdHistoryMsg ? 'historial_sincronizado'
      : message.broadcast || /@broadcast$/.test(message.from || '') ? 'estado_o_broadcast'
      : !flows[message.type] ? 'tipo_no_soportado'
      : !once(message) ? 'duplicado' : null;
    if (reason) {
      if (reason === 'tipo_no_soportado' || reason === 'notificacion') {
        logger.debug?.('Listener raw: mensaje ruido ignorado', {
          remoteJid: message.from, messageId: details.messageId, types: [message.type],
          action: 'conversation_listener_noise_skip', file: 'app.js',
        });
      }
      return;
    }
    const ctx = await provider.context(message);
    logger.info('contacto identificado', {
      ...details, numberPhone: ctx.from, chatId: ctx.key.remoteJid, action: 'wpp_contact_resolved',
    });
    if (message.type === 'chat' && !ctx.body.trim()) {
      logger.info('texto vacío, sin consulta IA', { ...details, numberPhone: ctx.from, action: 'wpp_empty_text' });
      return;
    }
    logger.debug?.('Listener raw: mensaje candidato a buffer', {
      remoteJid: ctx.key.remoteJid, remoteJidAlt: ctx.key.remoteJidAlt,
      messageId: ctx.key.id, messageTimestamp: ctx.messageTimestamp,
      messageTypes: [message.type], action: 'conversation_listener_candidate', file: 'app.js',
    });
    const entry = buffer.addReceivedMessage(ctx.from, {
      messageId: ctx.key.id,
      type: { chat: 'text', ptt: 'audio', audio: 'audio', image: 'image' }[message.type],
      content: message.type === 'chat' ? ctx.body : '',
      caption: ctx.caption,
      receivedAtMs: Date.now(),
      file: 'bot.js',
    });
    if (entry) {
      logger.info('Listener raw registró mensaje en buffer compartido', {
        phoneKey: entry.phoneKey, version: entry.version, duplicated: entry.duplicated,
        entryId: entry.entryId, type: entry.type,
        receivedAt: entry.receivedAt ? new Date(entry.receivedAt).toISOString() : null,
        action: 'conversation_listener_added', file: 'app.js',
      });
    }
    if (!entry || entry.duplicated) {
      logger.info('Mensaje omitido por el buffer compartido', {
        ...details, numberPhone: ctx.from, duplicated: entry?.duplicated, action: 'wpp_buffer_skipped',
      });
      return;
    }
    if (provider.paused.has(provider.resolve(ctx.from))) {
      const user = await aws.getWhatsapp(ctx.from, { name: ctx.pushName });
      if (user?.status) provider.paused.delete(provider.resolve(ctx.from));
    }
    if (!states.has(ctx.from)) states.set(ctx.from, {});
    // Metadatos del turno aislados; el historial sigue compartido por contacto.
    const turnState = {};
    const turnKeys = new Set(['conversationVersion', 'conversationEntryId', 'conversationPhoneKey']);
    const state = {
      getMyState: () => ({ ...states.get(ctx.from), ...turnState }),
      update: async (patch) => {
        const shared = { ...states.get(ctx.from) };
        for (const [key, value] of Object.entries(patch)) {
          if (turnKeys.has(key)) turnState[key] = value;
          else shared[key] = value;
        }
        states.set(ctx.from, shared);
        return state.getMyState();
      },
    };
    const startedAt = Date.now();
    logger.info('Iniciando flujo de negocio', {
      ...details, numberPhone: ctx.from, version: entry.version,
      silenceTextAudioSeconds: process.env.SILENCE_TEXT_AUDIO_SECONDS || '5',
      action: 'wpp_flow_start',
    });
    try {
      await flows[message.type](ctx, {
        state, provider,
        endFlow: () => undefined,
        flowDynamic: (text) => provider.sendMessage(ctx.from, text),
      });
    } finally {
      logger.info('Flujo de negocio finalizado; consulta los eventos de validación, IA y envío', {
        numberPhone: ctx.from, messageId: ctx.key.id, elapsedMs: Date.now() - startedAt,
        action: 'wpp_flow_finished',
      });
    }
  }

  async function own(message) {
    const rawMessage = message;
    message = provider.normalizeMessage(message);
    if (stopped || !message.fromMe || message.type !== 'chat' || message.isGroupMsg ||
        message.isMdHistoryMsg || message.isNotification || message.broadcast ||
        /@(g\.us|broadcast)$/.test(message.to || '') || !String(message.body || '').trim()) return;
    message = provider.ensureMessageId(message, 'onAnyMessage');
    try {
      const ctx = await provider.context(message);
      if (provider.isAutomated(rawMessage)) {
        logger.debug?.('Mensaje propio generado por el bot, se omite intervención manual', {
          messageId: getMessageId(message), action: 'own_message_skip_automated', file: 'app.js',
        });
        return;
      }
      if (!once(message)) return;
      await recordManual(ctx.from, String(message.body).trim(), ctx.pushName, '', '', { ctx });
    } catch (error) {
      if (/número|identificador/i.test(error.message)) {
        logger.warn?.('No se pudo extraer el número del mensaje manual', {
          remoteJid: message.to, error: error.message,
          action: 'own_message_phone_missing', file: 'app.js',
        });
      }
      logger.error('Error procesando mensaje manual propio', {
        error: error.message, stack: error.stack, remoteJid: message.to,
        action: 'own_message_processing_error', file: 'app.js',
      });
      throw error;
    }
  }

  function dispatch(handler, message) {
    const task = Promise.resolve().then(() => handler(message)).catch((error) => {
      if (!provider.isOwnMessage(message)) {
        logger.error('Error en listener entrada conversación', {
          error: error.message, stack: error.stack, remoteJid: message.from,
          action: 'conversation_listener_error', file: 'app.js',
        });
      }
      logger.error('Error procesando mensaje WPPConnect', {
        messageId: message.id, from: message.from, type: message.type,
        error: error.message, stack: error.stack, action: 'wpp_message_error',
      });
    });
    active.add(task);
    task.finally(() => active.delete(task));
    return task;
  }

  return {
    provider, recordManual, logger, services: aws,
    incoming, own,
    attach() {
      subscriptions.push(client.onMessage((message) => dispatch(incoming, message)));
      subscriptions.push(client.onAnyMessage((message) => provider.isOwnMessage(message)
        ? dispatch(own, message)
        : dispatch((incomingMessage) => incoming(incomingMessage, 'onAnyMessage'), message)));
      if (attachDiagnostics) subscriptions.push({ dispose: attachDiagnostics(client, logger) });
    },
    stop() {
      stopped = true;
      subscriptions.splice(0).forEach((subscription) => subscription?.dispose?.());
      for (const address of provider.addresses.values()) provider.paused.add(address);
    },
    async close() {
      stopped = true;
      await Promise.allSettled([...active]);
    },
  };
}

module.exports = { createBusinessRuntime, loadBusiness };

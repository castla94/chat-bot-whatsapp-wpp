// Diagnóstico nativo de WPPConnect sin contenido ni credenciales de los mensajes.
export function attachWhatsappDiagnostics(client, logger) {
    const subscriptions = [];
    if (client.onStateChange) {
        subscriptions.push(client.onStateChange((state) => {
            const connection = state === 'CONNECTED' ? 'open' : state === 'DISCONNECTED' ? 'close' : state;
            logger[state === 'DISCONNECTED' ? 'warn' : 'info']('Estado de conexión WhatsApp', {
                action: 'whatsapp_connection_update', state, connection, provider: 'wppconnect'
            });
            if (['UNPAIRED', 'UNPAIRED_IDLE'].includes(state)) {
                logger.error('Fallo de sesión WhatsApp; revisar logs/bot.log', {
                    action: 'whatsapp_auth_failure', provider: 'wppconnect'
                });
            }
        }));
    }
    if (client.onInterfaceChange) {
        subscriptions.push(client.onInterfaceChange(({ mode, displayInfo }) => {
            logger.info('Interfaz de WhatsApp actualizada', {
                action: 'whatsapp_interface_update', mode, displayInfo
            });
        }));
    }
    logger.info('Diagnóstico conectado al socket WhatsApp', { action: 'whatsapp_diagnostics_attached', provider: 'wppconnect' });
    logger.info('Proveedor WhatsApp conectado; recepción pendiente de verificar con un mensaje', {
        action: 'whatsapp_provider_ready', provider: 'wppconnect'
    });
    return () => subscriptions.forEach((subscription) => subscription?.dispose?.());
}

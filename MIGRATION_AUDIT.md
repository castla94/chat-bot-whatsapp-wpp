# Revisión de migración

Comparación contra `/Users/freyes/Documents/DEVELOPMENT/chat-bot-whatsapp`, incluido su `app.js`.

## Logs y procesos

- La auditoría estática revisa 269 referencias de mensajes de log en `app.js`, flujos, helpers y servicios. Se excluyen expresamente los logs `whatsapp_raw_message`, `wpp_message_skipped` y `wpp_message_received`, eliminados por petición del usuario. La referencia a `baileys.log` se adapta a `logs/bot.log`, conservando `whatsapp_auth_failure`.
- Se mantienen los logs de validación de whitelist, estado global/contacto, plan, créditos, historial, alarmas, productos, pedidos, procesamiento de voz/imagen y coordinación del buffer.
- Se restauran los mensajes y acciones de entrada al buffer, detección manual, estado del contacto, desactivación, omisión por contacto inexistente/whitelist y envíos por Express.
- Los eventos equivalentes del proveedor anterior se reciben mediante WPPConnect. Las etiquetas `file: app.js` de sus procesos se conservan para facilitar las búsquedas de logs existentes.
- La consola añade timestamp y los logs se guardan con rotación. No se vuelve a imprimir la variable `EMAIL_TOKEN` directamente al crear el logger.

## Mensaje manual desde WhatsApp

Se recibe en `onAnyMessage`. La dirección se reconoce por `fromMe`, las marcas equivalentes disponibles y la identidad del WhatsApp vinculado. Si falta ID, se genera un identificador local. Un LID se resuelve al teléfono real antes de consultar el backend.

Secuencia del origen conservada:

1. `Mensaje manual detectado` (`own_message_detected`).
2. `GET /whatsapp`: consultar el contacto.
3. `Estado del contacto para mensaje manual: activo|inactivo|sin_registro`.
4. Sin registro: `Mensaje manual omitido por contacto sin registro`; no desactivar ni guardar.
5. Activo: `POST /whatsapp` con `{ email, name, number, status: false }`; `Bot desactivado por mensaje manual`.
6. `GET /whatsapp-sessions-whitelist`.
7. En whitelist: `Conversación manual omitida por whitelist`; no registrar la conversación. La desactivación anterior se conserva, tal como en el origen.
8. Fuera de whitelist: `POST /whatsapp-conversation` con `message_user: ""`, `message_openia: texto` y `type_user: "openia"`.

Las respuestas del bot y los envíos programáticos se correlacionan con sus eventos propios para evitar clasificarlos como intervenciones desde el celular. La correlación de ecos sin ID es aproximada y tiene una ventana limitada; con ID nativo se usa ese identificador.

## API Express

Se conserva el proceso original de la API: enviar y registrar directamente la conversación. El endpoint no reutiliza las validaciones/desactivación del mensaje escrito desde el celular. Un archivo con texto adicional se envía como archivo y luego texto, como en el `app.js` original.

Los endpoints de envío siguen en `API_PORT` o `PORT + 10000`. Validan entradas, responden 503 durante la vinculación y eliminan temporales también si falla el envío.

## Verificación

- `npm run check`: sintaxis.
- `npm run audit:migration`: mensajes y acciones de logs presentes.
- `npm test`: 31 pruebas, incluyendo texto/audio/imagen combinados, bloqueos por whitelist/estado global/contacto, recepción sin ID y mensajes manuales.
- Las pruebas manuales usan los servicios AWS reales del proyecto con el adaptador HTTP simulado. Verifican método, endpoint, orden y cuerpo de las solicitudes sin modificar datos reales.

## Diferencias y pendientes externos

### Faltantes operativos confirmados en la revisión

| Prioridad | Proceso | Evidencia y efecto |
| --- | --- | --- |
| Alta | Recuperación si se cierra Chrome o se pierde el cliente | El proveedor Baileys del origen tiene reintentos y `reconnectVendor()`. El arranque actual crea WPPConnect una vez; `statusFind(browserClose)` solo elimina el QR. No existe un supervisor equivalente que reconstruya el cliente y reinstale listeners después de ese cierre. Esto no afirma que WhatsApp Web no pueda recuperar una pérdida temporal de red por su cuenta. |
| Alta | Estado real en `/health` después de desconectarse | `src/server.js` usa `Boolean(getRuntime())`. Tras conectarse una vez, `runtime` permanece asignado aunque se cierre el navegador; puede seguir informando `ready: true` y admitir solicitudes de envío que terminarán fallando. |
| Media | Servidor del QR en `PORT` | El origen llama a `httpServer(PORT)` y el proveedor sirve `<nombre>.qr.png` desde su ruta principal. Aquí solo arranca Express en `API_PORT` o `PORT + 10000`; `bot.qr.png` se guarda en disco y se imprime en consola. No hay un servidor equivalente del QR en `PORT`. |
| Media | Despliegue con PM2 y Docker | Faltan equivalentes adaptados de `start-pm2.sh` y `Dockerfile`. El origen usa `app.js` y Node 18; el destino arranca en `src/index.js`, requiere Node 22.9+ y un navegador con sus dependencias. |
| Media | Respaldo programado | No están adaptados `backup_session.sh` ni `crontab.txt`. El respaldo de WPPConnect debe cubrir el perfil `bot_sessions/`; el script original solo busca `baileys_store.json` y además elimina el archivo de destino tras copiarlo. Copiarlo literalmente no resolvería este proceso. |
| Baja / depende del servidor | Apache y CORS de los archivos de sesión | No se migraron `update_htaccess.sh`, `htaccess.txt` ni la tarea diaria que escribe `.htaccess`. Son mecanismos de Apache del despliegue antiguo, no middleware de Express ni flujos de conversación. Requieren revisar el despliegue real antes de trasladarlos. |

### Inventario comprobado

- Los tres flujos (`chatbot`, `voice`, `media`) están presentes.
- No hay funciones exportadas faltantes al comparar los cinco módulos de servicios y los cuatro helpers del origen con sus equivalentes del destino.
- Los 19 archivos de prompts y los cinco archivos principales de las integraciones auxiliares comparados son idénticos a los del origen.
- Todas las claves de variables del `.env` original existen en el `.env` local del destino. Esta revisión compara nombres sin imprimir valores.
- La auditoría de mensajes de log y acciones no reporta faltantes. Es una verificación estática, distinta de probar todas las ramas del negocio.
- `textToVoice` y `runDetermine` se conservaron como servicios auxiliares; no se agregan como nuevos flujos activos por el hecho de estar exportados.

### Cobertura pendiente

Hay pruebas de texto/audio/imagen combinados, bloqueos por whitelist/estado global/contacto, mensajes sin ID, llamadas de la API y secuencia de intervención manual. Aún falta cobertura específica de todas las ramas de alarmas, confirmación de pedidos, actualización dinámica de catálogo, créditos agotados, rechazo por plan y reinicio/desconexión del navegador. Esas ramas están presentes en el código; la falta identificada es de verificación automatizada, no de archivos de flujo.

- La conexión, sesiones, identificación de contactos, descarga de medios y presencia son de WPPConnect. No se ejecuta Baileys ni su servidor interno de BuilderBot en `PORT`; el QR se ofrece en consola y PNG, y la API Express mantiene su puerto propio.
- Se conservaron las correcciones necesarias del flujo de voz, el aislamiento de metadatos por turno, la limpieza de timers y los parámetros de OpenAI ajustados durante la migración.
- Los scripts originales de PM2, Docker y respaldo requieren adaptación al nuevo punto de entrada `src/index.js` y al perfil completo `bot_sessions/`. No se ejecutaron ni se copiaron scripts que asuman `app.js` o `baileys_store.json`.
- Las Lambdas auxiliares están en `integrations/` para despliegue independiente; no se desplegaron.
- Sigue pendiente una prueba desde el WhatsApp vinculado real: escribir a un contacto registrado, observar `own_message_detected`, `own_message_user_status_check`, `own_message_bot_disabled` cuando corresponda y verificar el cambio/registro en el backend. La comprobación automatizada no afirma que ese envío físico haya ocurrido.

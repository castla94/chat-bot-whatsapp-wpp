# Bot de WhatsApp con WPPConnect

Migración de `chat-bot-whatsapp` con la lógica de negocio original y conexión mediante `@wppconnect-team/wppconnect`. La autenticación sigue siendo por QR y guarda la sesión en `bot_sessions/` (por defecto, `bot_sessions/chatbot/`).

## Ejecutar

Requiere Node.js 22.9 o superior, npm y Chrome/Chromium.

```sh
npm install
npm start
```

El `.env` del proyecto de origen ya fue copiado localmente, conservando las variables existentes en el destino. No se versiona. Para una instalación nueva, copia `.env.example` a `.env` y completa `OPENAI_API_KEY`, `EMAIL_TOKEN` y la configuración de AWS que uses.

Cuando aparezca `QR disponible`, escanéalo desde **WhatsApp → Dispositivos vinculados → Vincular un dispositivo**. También puedes abrir `bot.qr.png`: cada renovación sobrescribe esa misma imagen. Se elimina al vincular la cuenta o cerrar el proceso normalmente.

Si el QR tarda en aparecer:

```sh
WPP_HEADLESS=false npm start
```

Detén la instancia anterior con `Ctrl+C` antes de iniciar otra. No se deben ejecutar simultáneamente el bot anterior y este bot sobre la misma conversación durante las pruebas.

## Comportamiento migrado

Una vez conectado, envía una consulta desde otro número. Los comandos de demostración `ping`, `hola` y `ayuda` fueron reemplazados por los flujos del proyecto original; `hola` pasa ahora por el prompt configurado en el backend.

- Texto: recupera configuración, estado del contacto, historial y prompt; consulta IA y registra la conversación y el consumo de créditos.
- Audio y notas de voz: descarga con WPPConnect, convierte con ffmpeg y transcribe antes de entrar al mismo flujo de conversación.
- Imágenes: conserva el caption, descarga, analiza y combina el resultado con el resto de mensajes de la conversación.
- Mensajes consecutivos: conserva el buffer compartido y la coordinación de turnos. Texto/audio usan `SILENCE_TEXT_AUDIO_SECONDS`; una imagen como último mensaje conserva la ventana original de 45 segundos.
- Conserva whitelist, activación global y por contacto, alarmas, notificaciones al vendedor, pedidos y actualización dinámica de productos.
- Un mensaje de texto manual desde el WhatsApp vinculado pausa el bot para ese contacto y registra la intervención según las reglas del proyecto de origen. Los envíos automáticos se identifican para evitar que pausen al propio bot. La reactivación se hace desde el backend/panel existente.
- La detección manual conserva los mensajes y acciones `own_message_*` del `app.js` original: consulta el contacto; si no existe, termina sin guardarlo; si está activo, envía `status: false` al backend; luego consulta whitelist y registra la conversación solo si no está incluida. Si el contacto ya está inactivo, registra el texto sin repetir la desactivación. La API conserva su proceso separado: registra directamente el envío sin aplicar la desactivación propia del celular.
- Ignora grupos, estados, notificaciones, historial sincronizado, stickers y tipos no admitidos; descarta eventos duplicados por ID.

La respuesta depende del estado del bot y contacto, whitelist, créditos y configuración del backend, igual que en el proyecto de origen. Los flujos se importan sin ejecutar las Lambdas ni realizar envíos de prueba a contactos reales.

## Estructura

- `src/index.js`: arranque WPPConnect, QR y API de envío.
- `src/bot.js`: recepción, enrutamiento, historial en memoria y eventos manuales.
- `src/providers/wppconnect.js`: adapta direcciones, LID, lectura, presencia, perfil, archivos y envíos a WPPConnect.
- `src/flow/`: flujos originales de texto, voz e imagen como funciones asíncronas.
- `src/services/`: servicios originales de OpenAI, backend AWS, audio e imagen.
- `src/helpers/`: buffer compartido, perfil y logs CloudWatch.
- `prompts/`: copia de los archivos de prompts del origen. El flujo activo sigue obteniendo el prompt desde el backend; estos archivos no se cargan automáticamente.
- `integrations/`: Lambdas auxiliares de Instagram, Messenger, sincronización de productos y extensión web, conservadas para despliegue independiente. La extensión web tiene su propio `package.json`; instala sus dependencias dentro de esa carpeta si la despliegas. Sus variables están en `integrations/.env.example`.

Los flujos y servicios migrados conservan ESM mediante sus `package.json` locales; el arranque usa CommonJS. No se necesitan BuilderBot, Baileys ni sus proveedores. Se migraron las dependencias ajenas a esa conexión y se añadió `@ffmpeg-installer/ffmpeg`, que el servicio de audio importaba pero no declaraba.

## API de envío manual

Por compatibilidad, escucha en **PORT + 10000** (si `PORT=3000`, usa `13000`). `API_PORT` permite asignar un puerto directo y `API_HOST` controla la interfaz de escucha. La API arranca mientras se vincula WhatsApp, pero responde `503` a los envíos hasta que el cliente esté listo.

```sh
curl http://localhost:13000/health

curl -X POST http://localhost:13000/send-message-bot \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"584121234567","message":"Hola"}'
```

`POST /send-media-bot` acepta `phoneNumber`, `message` opcional, `base64Media` y `type` (`imagen` o `file`). El contenido puede ser base64 puro o un data URI con MIME. Los archivos temporales se eliminan al terminar, incluso si falla el envío. El cuerpo JSON admite hasta 50 MB, como en el origen.

Los destinatarios admiten número internacional, `@c.us`, `@lid` y el antiguo `@s.whatsapp.net`, que se convierte para WPPConnect. Los identificadores LID entrantes se resuelven al teléfono real antes de consultar el backend.

## Variables

Consulta `.env.example` sin credenciales. Las variables heredadas incluyen `OPENAI_API_KEY`, `EMAIL_TOKEN`, `PORT`, `KEYWORD_CAPTURE_MESSAGE_ORDER`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` y `SILENCE_TEXT_AUDIO_SECONDS`.

- `WPP_SESSION`, `WPP_HEADLESS`, `WPP_AUTO_CLOSE`, `WPP_BROWSER_PATH`: conexión y navegador.
- `ENABLE_MODEL_CLASSIFICATION`: conserva la clasificación opcional original.
- `SILENCE_TEXT_AUDIO_SECONDS`: segundos fijos o rango como `45-60`.
- `CLOUDWATCH_ENABLED=false`: desactiva el transporte CloudWatch para desarrollo local; los logs de consola siguen activos.
- `WHATSAPP_API_BASE_URL`: cambia la URL del backend; por defecto conserva el endpoint del proyecto original.
- `HTTP_TIMEOUT_MS`: tiempo máximo para solicitudes del backend, por defecto 30000 ms.
- `FFMPEG_PATH`: reemplaza opcionalmente el ejecutable ffmpeg incluido.

No copies sesiones de Baileys a `bot_sessions/`. No compartas `.env`, archivos de sesión ni códigos QR. Audio, imágenes y temporales locales están excluidos de Git.

## Validación

Al arrancar se muestra la configuración efectiva sin credenciales. Para cada evento se registra `wpp_message_received` (mensaje y remitente), `wpp_contact_resolved` (teléfono real), el motivo si se descarta, las validaciones de negocio, `openai_request_start`, `openai_request_success` y `wpp_send_success` o sus errores. Los logs se muestran en consola y se guardan en `logs/bot.log`, con rotación. `LOG_TO_FILE=false` desactiva el archivo; `LOG_LEVEL=debug` añade detalle del flujo de negocio.

Si WhatsApp no entrega un ID, se asigna uno local con prefijo `generated-`; el mensaje continúa al flujo y al buffer. Los logs indican `messageIdSource: generated`. Para evitar respuestas dobles, las copias equivalentes de `onMessage` y `onAnyMessage` se emparejan durante 2 segundos usando remitente, destinatario, tipo, timestamp y contenido. Sin un ID nativo esta correlación es una aproximación; dos mensajes iguales recibidos por el mismo listener mantienen identificadores distintos. El ID generado sirve para la coordinación local, no para citar un mensaje mediante la API de WhatsApp.

`npm run diagnose` consulta el estado global y los créditos del backend sin conectar WhatsApp, consumir IA ni enviar mensajes. Mantiene las reglas de activación y whitelist del proyecto original. Si el flujo se detiene, revisa la última etapa registrada: foto de perfil, validación de estado, ventana de silencio, OpenAI o envío. La espera heredada de texto/audio sigue siendo de 45 segundos si así está configurada en `.env`.

```sh
npm run check
npm test
npm run audit:migration
npm run dev
```

Las pruebas usan clientes y servicios simulados para validar el adaptador y la lógica sin enviar mensajes reales ni consumir créditos. La comprobación final de extremo a extremo requiere vincular WhatsApp y probar texto, audio e imagen con una cuenta autorizada.

`npm run audit:migration` compara los textos de logs y sus acciones con el proyecto vecino `chat-bot-whatsapp`. También admite otra ruta: `npm run audit:migration -- /ruta/al/proyecto`. Es una comparación estática; las pruebas validan el comportamiento. Consulta [MIGRATION_AUDIT.md](MIGRATION_AUDIT.md) para ver diferencias intencionales y pendientes de despliegue.

## Documentación oficial

- [WPPConnect](https://wppconnect.io/wppconnect/)
- [Crear cliente y configurar sesión](https://wppconnect.io/docs/tutorial/basics/creating-client/)

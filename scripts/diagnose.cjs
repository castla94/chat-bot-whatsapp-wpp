// Solo consultas: no conecta WhatsApp, no consulta IA y no envía mensajes.
require('../src/env').loadEnv();
process.env.CLOUDWATCH_ENABLED = 'false';

async function main() {
  const config = require('../src/config');
  console.log('Configuración:', {
    apiPort: config.apiPort, session: config.session, sessionDirectory: config.folderNameToken,
    silenceTextAudioSeconds: process.env.SILENCE_TEXT_AUDIO_SECONDS || '5',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    backendIdentityConfigured: Boolean(process.env.EMAIL_TOKEN),
  });
  if (!process.env.OPENAI_API_KEY || !process.env.EMAIL_TOKEN) {
    throw new Error('Faltan OPENAI_API_KEY o EMAIL_TOKEN.');
  }
  const aws = await import('../src/services/aws/index.js');
  const { defaultLogger } = await import('../src/helpers/cloudWatchLogger.js');
  try {
    const [status, credits] = await Promise.all([aws.whatsappStatus(), aws.getWhatsappCredit()]);
    console.log('Diagnóstico del backend:', { globalStatus: status?.status ?? 'sin respuesta', credits });
    if (!status || credits === null) process.exitCode = 1;
  } finally {
    defaultLogger.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

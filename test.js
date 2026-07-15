import wppconnect from '@wppconnect-team/wppconnect';

const SESSION_NAME = 'sesion-local';
const LINK_PHONE_NUMBER = '56974593859';
const TEST_RECIPIENT = '56974593859@c.us';
const TOKEN_FOLDER = './tokens';

async function start() {
    const client = await wppconnect.create({
        session: SESSION_NAME,
        phoneNumber: LINK_PHONE_NUMBER,
        headless: false,
        waitForLogin: true,
        tokenStore: 'file',
        folderNameToken: TOKEN_FOLDER,
        createPathFileToken: true,
        catchLinkCode: (code) => {
            console.log('Codigo de vinculacion:', code);
        },
        statusFind: (status, session) => {
            console.log(`[${session}]`, status);
        },
    });

    console.log(`Sesion conectada y guardada en ${TOKEN_FOLDER}/${SESSION_NAME}`);

    const result = await client.sendText(
        TEST_RECIPIENT,
        'Mensaje de prueba enviado desde WPPConnect',
    );

    console.log('Mensaje de prueba enviado:', result?.id?._serialized ?? result);
}

start().catch((error) => {
    console.error('Error al iniciar WPPConnect:', error);
});

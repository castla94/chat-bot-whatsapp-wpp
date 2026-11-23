import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { splitMobilePayment } from '../src/helpers/paymentMessages.js';

const order = [
  'DATOS RECIBIDOS',
  '',
  'Nombre: Fernando Reyes  ',
  'Cédula: 24238952',
  '',
  'Pedido:',
  '• 1 Hamb Carne — $7',
  '',
  'Delivery: No  ',
  'Dirección: —  ',
  'Zona: —  ',
  'Costo de delivery: —',
  '',
  'Subtotal: $7  ',
  'TOTAL DEL PEDIDO: $7  ',
  'TOTAL A PAGAR EN BOLÍVARES: Bs. 6,431.36',
].join('\n');

const paymentDetails = [
  'DATOS DE PAGO  ',
  'Banco: 0102  ',
  'Teléfono: 04126882144  ',
  'C.I.: 29792586  ',
].join('\n');

const paymentInstructions = [
  'Monto a pagar: Bs. 6,431.36',
  '',
  'Por favor realiza el Pago Móvil y envía el comprobante para confirmar tu pedido. ¡Gracias! 😊',
  '',
  '07:39 p.m.',
].join('\n');

const response = [order, paymentDetails + '\n' + paymentInstructions].join('\n\n');

beforeEach((t) => {
  const original = process.env.PAGO_MOVIL;
  t.after(() => {
    if (original === undefined) delete process.env.PAGO_MOVIL;
    else process.env.PAGO_MOVIL = original;
  });
});

test('separa los datos de pago en el orden cédula, banco y teléfono', () => {
  process.env.PAGO_MOVIL = 'TRUE';

  assert.deepEqual(splitMobilePayment(response), [
    [order, paymentInstructions].join('\n\n'),
    '29792586\n0102\n04126882144',
  ]);
});

test('envía la respuesta completa con PAGO_MOVIL desactivado', () => {
  process.env.PAGO_MOVIL = 'FALSE';

  assert.deepEqual(splitMobilePayment(response), [response]);
});

test('envía la respuesta completa si PAGO_MOVIL no está configurado', () => {
  delete process.env.PAGO_MOVIL;

  assert.deepEqual(splitMobilePayment(response), [response]);
});

test('conserva la respuesta si falta la cédula del bloque de pago', () => {
  process.env.PAGO_MOVIL = 'TRUE';
  const incomplete = response.replace('C.I.: 29792586  \n', '');

  assert.deepEqual(splitMobilePayment(incomplete), [incomplete]);
});

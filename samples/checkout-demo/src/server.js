const logger = require('./logger');
const { checkout } = require('./checkout');
const { flush } = require('./tracing');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzQ4MTIiLCJpYXQiOjE3OTEwMDAwMDB9.Qm9vdHN0cmFwU2lnbmF0dXJlRm9yRGVtbw';
logger.info('server listening', { port: 3000 });

let n = 0;
async function tick() {
  n++;
  const order = { id: `ord_${1000 + n}`, total: n % 7 === 0 ? 512.4 : 20 + (n * 37) % 300 };
  await checkout({ userId: `user_${4800 + (n % 25)}`, cartId: `c${n}`, items: ['sku_1', 'sku_2', 'sku_3', 'sku_4'], order,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'demo' } });
  if (n % 5 === 0) logger.warn('slow inventory response', { durationMs: 850 + n % 200 });
  if (n < 400) setTimeout(tick, 350); else { await flush(); }
}
tick();

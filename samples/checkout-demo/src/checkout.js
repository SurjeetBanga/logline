const logger = require('./logger');
const { span } = require('./tracing');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chargeCard(order) {
  return span('payments', 'POST /charge', async () => {
    await wait(20 + Math.random() * 60);
    if (order.total > 400) throw new Error(`card declined for order ${order.id}`);
    return { receipt: `rcpt_${order.id}` };
  }, 2);
}

async function checkout(req) {
  return span('checkout-api', 'POST /checkout', async () => {
    logger.info('auth ok', { userId: req.userId, headers: req.headers });
    await span('inventory', 'reserve items', () => wait(10 + Math.random() * 30), 3);
    for (const item of req.items) logger.info(`cart ${req.cartId} has item ${item}`);
    try {
      const payment = await chargeCard(req.order);
      logger.info('payment captured', { orderId: req.order.id, durationMs: Math.round(40 + Math.random() * 90) });
      return payment;
    } catch (err) {
      logger.error('payment failed for order', { orderId: req.order.id });
    }
  });
}

module.exports = { checkout };

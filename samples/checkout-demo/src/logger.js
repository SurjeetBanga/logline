// A tiny JSON logger, like pino: one JSON object per line on stdout.
const { trace } = require('./tracing');

function write(level, msg, fields = {}) {
  const span = trace.current();
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, msg, service: 'checkout-api', ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}), ...fields }) + '\n');
}

module.exports = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};

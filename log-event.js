const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function parseLogLine(line, stream, id, receivedAt) {
  const trimmed = stripAnsi(line).trim();
  let value;
  try { value = JSON.parse(trimmed); } catch { value = undefined; }
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const level = normalizeLevel(object?.level ?? object?.severity, stream);
  const message = getMessage(object, value, trimmed);
  const timestampInfo = getTimestamp(object, receivedAt);
  const fields = object ? extractFields(object) : {};
  return {
    id, timestamp: timestampInfo.text, timestampMs: timestampInfo.ms, level, message: message.slice(0, 512), stream,
    isJson: value !== undefined, raw: trimmed, fields
  };
}
function normalizeLevel(level, stream) {
  if (typeof level === 'number') {
    return ({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' })[level]
      ?? (stream === 'stderr' ? 'error' : 'info');
  }
  const normalized = String(level ?? '').toLowerCase();
  if (LEVELS.includes(normalized)) return normalized;
  if (normalized === 'warning') return 'warn';
  if (normalized === 'critical') return 'fatal';
  return stream === 'stderr' ? 'error' : 'info';
}
function getMessage(object, value, fallback) {
  const candidate = object?.message ?? object?.msg ?? object?.event ?? object?.name;
  if (candidate !== undefined) return String(candidate);
  if (value === undefined || typeof value === 'string') return String(value ?? fallback);
  if (Array.isArray(value)) return `Array (${value.length} items)`;
  return 'JSON event';
}
function getTimestamp(object, receivedAt) {
  const candidate = object?.timestamp ?? object?.time ?? object?.ts ?? object?.datetime;
  if (candidate !== undefined) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return { text: formatTime(parsed), ms: parsed.getTime() };
  }
  return { text: formatTime(receivedAt), ms: receivedAt.getTime() };
}
function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}
function stripAnsi(value) { return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''); }
function extractFields(object) {
  const keys = ['service', 'logger', 'requestId', 'traceId', 'spanId', 'method', 'path', 'status', 'statusCode', 'duration', 'durationMs', 'userId', 'host', 'environment'];
  return Object.fromEntries(keys.filter(key => object[key] !== undefined && (typeof object[key] === 'string' || typeof object[key] === 'number' || typeof object[key] === 'boolean')).map(key => [key, object[key]]));
}
module.exports = { parseLogLine, normalizeLevel, stripAnsi };

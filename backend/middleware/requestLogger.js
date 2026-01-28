import { logBuffer as defaultLogBuffer } from '../services/logBuffer.js';

export const requestLoggerMiddleware = ({
  logBuffer = defaultLogBuffer,
  console = globalThis.console,
  now = () => new Date().toISOString()
} = {}) => {
  return (req, res, next) => {
    const startedAt = typeof req.requestStartedAt === 'bigint' ? req.requestStartedAt : process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const correlationId = typeof req.correlationId === 'string' && req.correlationId.trim()
        ? req.correlationId
        : null;

      const entry = {
        level: 'info',
        message: 'http_request',
        correlationId,
        meta: {
          method: req.method,
          path: req.originalUrl || req.path,
          statusCode: res.statusCode,
          durationMs
        }
      };

      logBuffer.add(entry);
      console.log(JSON.stringify({ ts: now(), ...entry }));
    });

    next();
  };
};

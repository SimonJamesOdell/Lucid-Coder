import { randomUUID } from 'crypto';

const HEADER_NAME = 'x-correlation-id';

const normalizeCorrelationId = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  // Keep the header reasonably small and log-friendly.
  const clipped = raw.slice(0, 128);
  return clipped;
};

export const requestContextMiddleware = () => {
  return (req, res, next) => {
    const fromHeader = normalizeCorrelationId(req.get(HEADER_NAME));
    const correlationId = fromHeader || randomUUID();

    req.correlationId = correlationId;
    req.requestStartedAt = process.hrtime.bigint();

    res.setHeader(HEADER_NAME, correlationId);

    next();
  };
};

export const __requestContextTesting = {
  normalizeCorrelationId,
  HEADER_NAME
};

import { logBuffer as defaultLogBuffer } from '../services/logBuffer.js';

export const errorHandlerMiddleware = ({
  logBuffer = defaultLogBuffer,
  console = globalThis.console
} = {}) => {
  return (error, req, res, next) => {
    const correlationId = typeof req?.correlationId === 'string' ? req.correlationId : null;

    logBuffer.add({
      level: 'error',
      message: 'server_error',
      correlationId,
      meta: {
        message: error?.message || String(error)
      }
    });

    console.error('❌ Server error:', error);

    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON format'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  };
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl
  });
};

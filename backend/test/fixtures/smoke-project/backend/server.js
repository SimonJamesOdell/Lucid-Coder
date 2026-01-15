const http = require('http');

const port = Number(process.env.PORT) || 0;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', port }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('backend running');
});

server.listen(port, () => {
  console.log(`[smoke-backend] listening on ${port}`);
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

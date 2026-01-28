import express from 'express';
import { buildDiagnosticsBundle } from '../services/diagnosticsBundle.js';

const router = express.Router();

router.get('/bundle', async (req, res) => {
  const bundle = await buildDiagnosticsBundle();

  const ts = bundle.generatedAt.replace(/[:.]/g, '-');
  const filename = `lucidcoder-diagnostics-${bundle.version}-${ts}.json`;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  res.status(200).json({ success: true, bundle });
});

export default router;

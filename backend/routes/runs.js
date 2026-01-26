import express from 'express';
import { getRun, listRunEvents, listRunsForProject } from '../services/runStore.js';

const router = express.Router({ mergeParams: true });

router.get('/', async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const runs = await listRunsForProject(projectId, { limit });
    res.status(200).json({ success: true, runs });
  } catch (error) {
    console.error('[Runs] List failed:', error);
    res.status(500).json({ success: false, error: 'Failed to list runs' });
  }
});

router.get('/:runId', async (req, res) => {
  try {
    const { projectId, runId } = req.params;
    const includeEventsValue = req.query.includeEvents;
    const includeEvents = String(includeEventsValue || '').toLowerCase() === 'true'
      || String(includeEventsValue || '') === '1';

    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const runRecord = await getRun(runId);
    if (!runRecord || String(runRecord.projectId) !== String(projectId)) {
      return res.status(404).json({ success: false, error: 'Run not found' });
    }

    if (!includeEvents) {
      return res.status(200).json({ success: true, run: runRecord });
    }

    const events = await listRunEvents(runId);
    res.status(200).json({ success: true, run: runRecord, events });
  } catch (error) {
    console.error('[Runs] Get failed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch run' });
  }
});

router.get('/:runId/events', async (req, res) => {
  try {
    const { projectId, runId } = req.params;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const afterId = req.query.afterId ? Number(req.query.afterId) : undefined;
    const types = typeof req.query.types === 'string' ? req.query.types : undefined;

    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }

    const runRecord = await getRun(runId);
    if (!runRecord || String(runRecord.projectId) !== String(projectId)) {
      return res.status(404).json({ success: false, error: 'Run not found' });
    }

    const events = await listRunEvents(runId, { limit, afterId, types });
    res.status(200).json({ success: true, run: runRecord, events });
  } catch (error) {
    console.error('[Runs] Events failed:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch run events' });
  }
});

export default router;

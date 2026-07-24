import { Router } from 'express';
import { WorkflowsManager } from '../workflows-manager';

export function workflowsRoutes(workflows: WorkflowsManager): Router {
  const r = Router();

  r.get('/workflows', (_req, res) => {
    res.json(workflows.list());
  });

  r.post('/workflows', (req, res) => {
    try {
      const body = req.body as { name?: string; command?: string; cwd?: string };
      const wf = workflows.create(String(body.name ?? ''), String(body.command ?? ''), body.cwd);
      res.json({ ok: true, workflow: wf });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.post('/workflows/:id/run', (req, res) => {
    try {
      const result = workflows.run(req.params.id);
      res.json({ ok: true, ...result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 409).json({ error: msg });
    }
  });

  r.delete('/workflows/:id', (req, res) => {
    if (workflows.delete(req.params.id)) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Workflow not found' });
    }
  });

  return r;
}

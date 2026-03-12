'use strict';
const express = require('express');
const { checkApiKey, requireScope } = require('./auth');
const { recall, store, feedback, getStats } = require('./memory');
const { isOllamaReady } = require('./embedding');
const { getDb } = require('./db');

const app  = express();
const PORT = parseInt(process.env.PORT || '3457');
const START_TIME = Date.now();

app.use(express.json({ limit: '1mb' }));

// Globaler Request-Timeout (verhindert Hänger bei Ollama-Ausfall)
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '45000');
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout' });
    }
  });
  next();
});

// ─── Health-Check ─────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const ollamaOk = await isOllamaReady();
  let dbOk = false;
  try { getDb(); dbOk = true; } catch {}
  const status = ollamaOk && dbOk ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    db: dbOk ? 'ok' : 'error',
    ollama: ollamaOk ? 'ok' : 'unavailable',
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    version: '1.0.0'
  });
});

// ─── MCP Endpoints ────────────────────────────────────────────────────────
app.post('/mcp/recall', checkApiKey, requireScope('recall'), async (req, res) => {
  const t0 = Date.now();
  try {
    const { task_description, namespace = 'global', shared_namespaces = [] } = req.body;
    if (!task_description) return res.status(400).json({ error: 'task_description erforderlich' });

    const result = await recall(task_description, namespace, shared_namespaces);

    logAccess(req.apiKey.id, '/mcp/recall', namespace, Date.now() - t0, 200);
    res.json({ ...result, namespace, agent: req.apiKey.name });
  } catch (err) {
    console.error('[recall]', err);
    logAccess(req.apiKey?.id, '/mcp/recall', req.body?.namespace, Date.now() - t0, 500);
    res.status(500).json({ error: err.message });
  }
});

app.post('/mcp/store', checkApiKey, requireScope('store'), async (req, res) => {
  const t0 = Date.now();
  try {
    const { experience, namespace = 'global' } = req.body;
    if (!experience) return res.status(400).json({ error: 'experience Objekt erforderlich' });

    const result = await store(experience, namespace, req.apiKey.name);

    logAccess(req.apiKey.id, '/mcp/store', namespace, Date.now() - t0, 201);
    res.status(201).json({ ...result, namespace });
  } catch (err) {
    console.error('[store]', err);
    logAccess(req.apiKey?.id, '/mcp/store', req.body?.namespace, Date.now() - t0, 500);
    res.status(500).json({ error: err.message });
  }
});

app.post('/mcp/feedback', checkApiKey, requireScope('store'), (req, res) => {
  try {
    const { episode_id, success } = req.body;
    if (!episode_id || success === undefined) {
      return res.status(400).json({ error: 'episode_id und success erforderlich' });
    }
    const result = feedback(episode_id, !!success);
    res.json(result);
  } catch (err) {
    console.error('[feedback]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats Endpoint (intern für admin-api) ────────────────────────────────
app.get('/internal/stats', (req, res) => {
  const internalKey = req.headers['x-internal-key'];
  if (internalKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Nicht autorisiert' });
  }
  res.json(getStats());
});

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────
function logAccess(keyId, endpoint, namespace, latencyMs, status) {
  try {
    getDb().prepare(`
      INSERT INTO access_log (key_id, endpoint, namespace, latency_ms, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(keyId || 'unknown', endpoint, namespace, latencyMs, status);
  } catch {}
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[memory-service] Läuft auf Port ${PORT}`);
  console.log(`[memory-service] Ollama URL: ${process.env.OLLAMA_URL}`);
});

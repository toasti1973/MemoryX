'use strict';
const express  = require('express');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = parseInt(process.env.PORT || '3459');

const ADMIN_API_KEY    = process.env.ADMIN_API_KEY || '';
const ADMIN_DB_PATH    = process.env.ADMIN_DB_PATH    || '/data/admin.db';
const MEMCP_DB_PATH    = process.env.MEMCP_DB_PATH    || '/memcp/graph.db';
const AUTH_LOG_DB_PATH = process.env.AUTH_LOG_DB_PATH  || '/data/auth_log.db';
const BACKUP_PATH      = process.env.BACKUP_PATH      || '/backups';
const MEMCP_URL        = process.env.MEMCP_URL         || 'http://memcp:3457';

if (!ADMIN_API_KEY || ADMIN_API_KEY === 'changeme') {
  console.warn('[admin-api] WARNUNG: ADMIN_API_KEY ist nicht gesetzt oder unsicher!');
}

app.use(express.json({ limit: '100kb' }));
const ALLOWED_ORIGIN = `https://${process.env.MEMORY_HOST || 'memory.local'}`;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Admin-Auth Middleware (timing-safe comparison)
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || typeof key !== 'string') return res.status(401).json({ error: 'Unauthorized' });
  if (!ADMIN_API_KEY) return res.status(401).json({ error: 'ADMIN_API_KEY not configured' });
  const keyBuf    = Buffer.from(key);
  const adminBuf  = Buffer.from(ADMIN_API_KEY);
  if (keyBuf.length !== adminBuf.length || !crypto.timingSafeEqual(keyBuf, adminBuf)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Datenbank-Helfer ───────────────────────────────────────────────────
function getMemcpDb() {
  try {
    const db = new Database(MEMCP_DB_PATH, { fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function getAuthLogDb() {
  try {
    const db = new Database(AUTH_LOG_DB_PATH, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

function getAdminDb() {
  const db = new Database(ADMIN_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      key_value  TEXT NOT NULL UNIQUE,
      scope      TEXT NOT NULL DEFAULT 'recall+store',
      namespaces TEXT NOT NULL DEFAULT '*',
      rate_limit INTEGER NOT NULL DEFAULT 60,
      expires_at INTEGER,
      last_used  INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT NOT NULL DEFAULT 'admin',
      active     INTEGER NOT NULL DEFAULT 1,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS rules (
      id             TEXT PRIMARY KEY,
      project        TEXT NOT NULL DEFAULT '',
      category       TEXT NOT NULL DEFAULT '',
      rule_text      TEXT NOT NULL,
      confidence     REAL NOT NULL DEFAULT 0.5,
      source_count   INTEGER NOT NULL DEFAULT 0,
      confirmed      INTEGER NOT NULL DEFAULT 0,
      apply_count    INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  try { db.exec('ALTER TABLE api_keys ADD COLUMN revoked_at INTEGER'); } catch { /* column exists */ }
  return db;
}

// ─── /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', adminAuth, async (_req, res) => {
  const services = {};

  // memcp Health-Check (TCP statt HTTP — streamable-http akzeptiert kein einfaches GET)
  try {
    const net = require('net');
    await new Promise((resolve, reject) => {
      const url = new URL(MEMCP_URL);
      const sock = net.createConnection({ host: url.hostname, port: url.port || 3457, timeout: 5000 });
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
      sock.on('error', reject);
    });
    services['memcp'] = 'ok';
  } catch { services['memcp'] = 'offline'; }

  // Ollama Health-Check
  try {
    const r = await fetch('http://ollama:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    services['ollama'] = r.ok ? 'ok' : 'error';
  } catch { services['ollama'] = 'offline'; }

  services['admin-api'] = 'ok';

  const allOk = Object.values(services).every(s => s === 'ok');
  res.json({ status: allOk ? 'ok' : 'degraded', services, timestamp: Date.now() });
});

// ─── /api/stats ──────────────────────────────────────────────────────────
app.get('/api/stats', adminAuth, (_req, res) => {
  const memcpDb = getMemcpDb();
  const adminDb = getAdminDb();
  let insightCount = 0, edgeCount = 0, avgImportance = 0, projectCount = 0, ruleCount = 0;
  let hitRate = null, totalInsights = 0, usedInsights = 0;
  let dbSize = 0;

  if (memcpDb) {
    try { insightCount = memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes').get()?.cnt || 0; } catch {}
    try { edgeCount = memcpDb.prepare('SELECT COUNT(*) as cnt FROM edges').get()?.cnt || 0; } catch {}
    try {
      const avg = memcpDb.prepare('SELECT AVG(importance) as avg FROM nodes').get();
      avgImportance = avg?.avg ? parseFloat(avg.avg.toFixed(3)) : 0;
    } catch {}
    try { projectCount = memcpDb.prepare('SELECT COUNT(DISTINCT project) as cnt FROM nodes WHERE project IS NOT NULL AND project != ""').get()?.cnt || 0; } catch {}
    // Hit-Rate: Anteil genutzter Insights (access_count > 0) vs. Gesamt
    try {
      const total  = memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes').get()?.cnt || 0;
      const used   = memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE access_count > 0').get()?.cnt || 0;
      hitRate      = total > 0 ? parseFloat((used / total * 100).toFixed(1)) : null;
      totalInsights = total;
      usedInsights  = used;
    } catch {}
    memcpDb.close();
  }

  try { ruleCount = adminDb.prepare('SELECT COUNT(*) as cnt FROM rules').get()?.cnt || 0; } catch {}
  adminDb.close();

  try { dbSize = fs.statSync(MEMCP_DB_PATH).size; } catch {}

  res.json({
    insightCount, edgeCount, ruleCount, projectCount, avgImportance,
    dbSizeBytes: dbSize, dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
    hitRate, totalInsights, usedInsights,
  });
});

// ─── /api/keys ───────────────────────────────────────────────────────────
app.get('/api/keys', adminAuth, (_req, res) => {
  const db = getAdminDb();
  try {
    const keys = db.prepare('SELECT id, name, scope, namespaces, rate_limit, expires_at, last_used, created_at, created_by, active FROM api_keys ORDER BY created_at DESC').all();
    res.json(keys);
  } finally {
    db.close();
  }
});

const VALID_SCOPES = new Set(['recall', 'store', 'recall+store', 'admin']);

app.post('/api/keys', adminAuth, (req, res) => {
  const { name, scope = 'recall+store', namespaces = '*', rate_limit = 60, expires_at } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 64)
    return res.status(400).json({ error: 'name erforderlich (max. 64 Zeichen)' });
  if (!VALID_SCOPES.has(scope))
    return res.status(400).json({ error: `Ungueltiger scope. Erlaubt: ${[...VALID_SCOPES].join(', ')}` });
  const rl = parseInt(rate_limit);
  if (isNaN(rl) || rl < 1 || rl > 10000)
    return res.status(400).json({ error: 'rate_limit muss zwischen 1 und 10000 liegen' });
  if (typeof namespaces !== 'string' || namespaces.length > 256)
    return res.status(400).json({ error: 'namespaces ungueltig (max. 256 Zeichen)' });

  const id  = uuidv4();
  const key = 'mc-' + uuidv4().replace(/-/g, '').substring(0, 24);

  const db = getAdminDb();
  try {
    db.prepare(`
      INSERT INTO api_keys (id, name, key_value, scope, namespaces, rate_limit, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, key, scope, namespaces, rl, expires_at || null);
  } finally {
    db.close();
  }

  res.status(201).json({ id, name, key, scope, namespaces, rate_limit: rl });
});

app.delete('/api/keys/:id', adminAuth, (req, res) => {
  const db = getAdminDb();
  try {
    db.prepare('UPDATE api_keys SET active = 0, revoked_at = unixepoch() WHERE id = ?').run(req.params.id);
  } finally {
    db.close();
  }
  res.json({ revoked: true });
});

// ─── /api/insights (memcp nodes-Tabelle, Alias: /api/episodes) ──────────
function listInsights(req, res) {
  const memcpDb = getMemcpDb();
  if (!memcpDb) return res.json([]);
  try {
    const { q, project, namespace, limit = 50 } = req.query;
    const parsedLimit = Math.max(1, Math.min(1000, parseInt(limit) || 50));
    let sql = 'SELECT id, category, summary, content, importance, effective_importance, project, session, tags, access_count, feedback_score, created_at FROM nodes';
    const params = [];
    const where = [];
    if (q) {
      const escaped = q.replace(/[%_]/g, '\\$&');
      where.push('(content LIKE ? ESCAPE "\\" OR summary LIKE ? ESCAPE "\\" OR tags LIKE ? ESCAPE "\\")');
      params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    if (project) { where.push('project = ?'); params.push(project); }
    if (namespace && !project) { where.push('project = ?'); params.push(namespace); } // namespace is legacy alias for project
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parsedLimit);
    const rows = memcpDb.prepare(sql).all(...params);
    res.json(rows);
  } finally {
    memcpDb.close();
  }
}
app.get('/api/insights', adminAuth, listInsights);
app.get('/api/episodes', adminAuth, listInsights);

function deleteInsight(req, res) {
  let memcpDb;
  try {
    memcpDb = new Database(MEMCP_DB_PATH);
    memcpDb.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(req.params.id, req.params.id);
    memcpDb.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memcpDb) memcpDb.close();
  }
}
app.delete('/api/insights/:id', adminAuth, deleteInsight);
app.delete('/api/episodes/:id', adminAuth, deleteInsight);

// ─── /api/rules (in admin.db, erstellt durch Scheduler-Destillierung) ───
app.get('/api/rules', adminAuth, (_req, res) => {
  const db = getAdminDb();
  try {
    const rows = db.prepare('SELECT id, project, category, rule_text, confidence, source_count, apply_count, confirmed, created_at FROM rules ORDER BY confidence DESC').all();
    res.json(rows);
  } finally {
    db.close();
  }
});

app.post('/api/rules/:id/confirm', adminAuth, (req, res) => {
  const db = getAdminDb();
  try {
    db.prepare('UPDATE rules SET confirmed = 1 WHERE id = ?').run(req.params.id);
    res.json({ confirmed: true });
  } finally {
    db.close();
  }
});

app.delete('/api/rules/:id', adminAuth, (req, res) => {
  const db = getAdminDb();
  try {
    db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  } finally {
    db.close();
  }
});

// ─── /api/backup ─────────────────────────────────────────────────────────
app.post('/api/backup', adminAuth, async (_req, res) => {
  let memcpDb;
  try {
    if (!fs.existsSync(MEMCP_DB_PATH)) return res.status(404).json({ error: 'memcp DB (graph.db) nicht gefunden' });
    fs.mkdirSync(BACKUP_PATH, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const dest = path.join(BACKUP_PATH, `graph-${ts}.db`);
    memcpDb = new Database(MEMCP_DB_PATH, { readonly: true });
    await memcpDb.backup(dest);
    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
    res.json({ backup: dest, sizeMB, created: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memcpDb) memcpDb.close();
  }
});

// ─── /api/gc ─────────────────────────────────────────────────────────────
app.post('/api/gc', adminAuth, (_req, res) => {
  let memcpDb;
  try {
    memcpDb = new Database(MEMCP_DB_PATH);
    const deleted = memcpDb.prepare('DELETE FROM nodes WHERE importance < 0.1').run();
    const orphans = memcpDb.prepare(`
      DELETE FROM edges WHERE source_id NOT IN (SELECT id FROM nodes)
         OR target_id NOT IN (SELECT id FROM nodes)
    `).run();
    memcpDb.pragma('VACUUM');
    res.json({ deletedWeak: deleted.changes, deletedOrphanEdges: orphans.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memcpDb) memcpDb.close();
  }
});

// ─── /api/logs (kombiniert auth_log + graph.db Insight-Aktivität) ───────
app.get('/api/logs', adminAuth, (req, res) => {
  const { lines = 100 } = req.query;
  const parsedLines = Math.max(1, Math.min(1000, parseInt(lines) || 100));
  const combined = [];

  // 1. Auth-Proxy Logs (historisch, falls vorhanden)
  const logDb = getAuthLogDb();
  if (logDb) {
    try {
      const rows = logDb.prepare(`
        SELECT id, key_id, key_name, method, path as endpoint, status, latency_ms, created_at,
               'auth' as source
        FROM auth_log
        ORDER BY created_at DESC LIMIT ?
      `).all(parsedLines);
      for (const r of rows) {
        combined.push({
          ...r,
          created_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
        });
      }
    } finally {
      logDb.close();
    }
  }

  // 2. Graph.db — Insight-Zugriffe (access_count > 0 = wurde abgerufen)
  const memcpDb = getMemcpDb();
  if (memcpDb) {
    try {
      // Erstellte Insights (remember)
      const created = memcpDb.prepare(`
        SELECT id, category, project, summary, created_at
        FROM nodes ORDER BY created_at DESC LIMIT ?
      `).all(parsedLines);
      for (const n of created) {
        combined.push({
          id: 'c-' + n.id,
          key_name: n.project || 'default',
          method: 'remember',
          endpoint: n.category || 'general',
          status: 201,
          latency_ms: null,
          created_at: n.created_at,
          summary: n.summary || n.id,
          source: 'graph',
        });
      }
      // Abgerufene Insights (recall/search)
      const accessed = memcpDb.prepare(`
        SELECT id, category, project, summary, access_count, last_accessed_at
        FROM nodes WHERE access_count > 0 AND last_accessed_at IS NOT NULL
        ORDER BY last_accessed_at DESC LIMIT ?
      `).all(parsedLines);
      for (const n of accessed) {
        combined.push({
          id: 'a-' + n.id,
          key_name: n.project || 'default',
          method: 'recall',
          endpoint: n.category || 'general',
          status: 200,
          latency_ms: null,
          created_at: n.last_accessed_at,
          summary: n.summary || n.id,
          access_count: n.access_count,
          source: 'graph',
        });
      }
    } finally {
      memcpDb.close();
    }
  }

  // Nach Zeitstempel sortieren (neueste zuerst), auf limit kürzen
  combined.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(combined.slice(0, parsedLines));
});

// ─── /api/memcp/stats (Bridge-Route — detaillierte memcp-Statistiken) ───
app.get('/api/memcp/stats', adminAuth, (_req, res) => {
  const memcpDb = getMemcpDb();
  if (!memcpDb) return res.json({ error: 'graph.db nicht gefunden' });
  try {
    const nodes = memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes').get();
    const edges = memcpDb.prepare('SELECT COUNT(*) as cnt FROM edges').get();
    let categories = [], projects = [], importanceDist = {};
    try {
      categories = memcpDb.prepare('SELECT category, COUNT(*) as cnt FROM nodes WHERE category IS NOT NULL AND category != "" GROUP BY category ORDER BY cnt DESC LIMIT 20').all();
    } catch {}
    try {
      projects = memcpDb.prepare('SELECT project, COUNT(*) as cnt FROM nodes WHERE project IS NOT NULL AND project != "" GROUP BY project ORDER BY cnt DESC').all();
    } catch {}
    try {
      importanceDist = {
        high: memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE importance >= 0.7').get()?.cnt || 0,
        medium: memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE importance >= 0.3 AND importance < 0.7').get()?.cnt || 0,
        low: memcpDb.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE importance < 0.3').get()?.cnt || 0,
      };
    } catch {}
    res.json({ nodeCount: nodes?.cnt || 0, edgeCount: edges?.cnt || 0, categories, projects, importanceDist });
  } finally {
    memcpDb.close();
  }
});

// ─── /api/memcp/graph (Bridge-Route — Graph-Exploration) ────────────────
app.get('/api/memcp/graph', adminAuth, (_req, res) => {
  const memcpDb = getMemcpDb();
  if (!memcpDb) return res.json({ error: 'graph.db nicht gefunden' });
  try {
    let edgeTypes = [], topEntities = [], recentNodes = [];
    try { edgeTypes = memcpDb.prepare('SELECT edge_type, COUNT(*) as cnt FROM edges GROUP BY edge_type ORDER BY cnt DESC').all(); } catch {}
    try { topEntities = memcpDb.prepare('SELECT entity, COUNT(*) as cnt FROM entity_index GROUP BY entity ORDER BY cnt DESC LIMIT 20').all(); } catch {}
    try { recentNodes = memcpDb.prepare('SELECT id, summary, category, importance, project, created_at FROM nodes ORDER BY created_at DESC LIMIT 10').all(); } catch {}
    res.json({ edgeTypes, topEntities, recentNodes });
  } finally {
    memcpDb.close();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[admin-api] Laeuft auf Port ${PORT}`);
  console.log(`[admin-api] memcp DB: ${MEMCP_DB_PATH}`);
  console.log(`[admin-api] Admin DB: ${ADMIN_DB_PATH}`);
});

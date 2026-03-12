'use strict';
const express  = require('express');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = parseInt(process.env.PORT || '3459');

const ADMIN_API_KEY  = process.env.ADMIN_API_KEY || 'changeme';
const MEMORY_DB_PATH = process.env.MEMORY_DB_PATH || '/memory/memory.db';
const ADMIN_DB_PATH  = process.env.ADMIN_DB_PATH  || '/data/admin.db';
const BACKUP_PATH    = process.env.BACKUP_PATH    || '/backups';
const MEMORY_SVC_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3457';

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
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || typeof key !== 'string') return res.status(401).json({ error: 'Unauthorized' });
  const keyBuf    = Buffer.from(key);
  const adminBuf  = Buffer.from(ADMIN_API_KEY);
  if (keyBuf.length !== adminBuf.length || !crypto.timingSafeEqual(keyBuf, adminBuf)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function getMemoryDb() {
  if (!fs.existsSync(MEMORY_DB_PATH)) return null;
  return new Database(MEMORY_DB_PATH, { readonly: true });
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
  `);
  // Migration: revoked_at-Spalte hinzufügen falls nicht vorhanden
  try { db.exec('ALTER TABLE api_keys ADD COLUMN revoked_at INTEGER'); } catch {}
  return db;
}

// ─── /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', adminAuth, async (_req, res) => {
  const services = {};
  try {
    const r = await fetch(`${MEMORY_SVC_URL}/health`, { signal: AbortSignal.timeout(5000) });
    services['memory-service'] = r.ok ? 'ok' : 'error';
  } catch { services['memory-service'] = 'offline'; }
  res.json({ status: 'ok', services, timestamp: Date.now() });
});

// ─── /api/stats ──────────────────────────────────────────────────────────
app.get('/api/stats', adminAuth, async (_req, res) => {
  let memStats = {};
  try {
    const r = await fetch(`${MEMORY_SVC_URL}/internal/stats`, {
      headers: { 'X-Internal-Key': ADMIN_API_KEY },
      signal: AbortSignal.timeout(5000)
    });
    if (r.ok) memStats = await r.json();
  } catch {}

  let dbSize = 0;
  try { dbSize = fs.statSync(MEMORY_DB_PATH).size; } catch {}

  res.json({ ...memStats, dbSizeBytes: dbSize, dbSizeMB: (dbSize / 1024 / 1024).toFixed(2) });
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
    return res.status(400).json({ error: `Ungültiger scope. Erlaubt: ${[...VALID_SCOPES].join(', ')}` });
  const rl = parseInt(rate_limit);
  if (isNaN(rl) || rl < 1 || rl > 10000)
    return res.status(400).json({ error: 'rate_limit muss zwischen 1 und 10000 liegen' });
  if (typeof namespaces !== 'string' || namespaces.length > 256)
    return res.status(400).json({ error: 'namespaces ungültig (max. 256 Zeichen)' });

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

  syncKeyToMemoryService(id, name, key, scope, namespaces, rl, expires_at);
  res.status(201).json({ id, name, key, scope, namespaces, rate_limit });
});

app.delete('/api/keys/:id', adminAuth, (req, res) => {
  const db = getAdminDb();
  try {
    db.prepare('UPDATE api_keys SET active = 0, revoked_at = unixepoch() WHERE id = ?').run(req.params.id);
  } finally {
    db.close();
  }
  syncKeyRevocation(req.params.id);
  res.json({ revoked: true });
});

// ─── /api/episodes ───────────────────────────────────────────────────────
app.get('/api/episodes', adminAuth, (req, res) => {
  const memDb = getMemoryDb();
  if (!memDb) return res.json([]);
  try {
    const { q, namespace, limit = 50 } = req.query;
    const parsedLimit = Math.max(1, Math.min(1000, parseInt(limit) || 50));
    let sql = 'SELECT id, agent_id, namespace, task_category, outcome, context_summary, quality_score, created_at FROM episodes';
    const params = [];
    const where = [];
    if (q) { where.push('(context_summary LIKE ? OR learnings LIKE ? OR task_category LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (namespace) { where.push('namespace = ?'); params.push(namespace); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parsedLimit);
    const rows = memDb.prepare(sql).all(...params);
    res.json(rows);
  } finally {
    memDb.close();
  }
});

app.delete('/api/episodes/:id', adminAuth, (req, res) => {
  let memDb;
  try {
    memDb = new Database(MEMORY_DB_PATH);
    memDb.prepare('DELETE FROM episodes WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memDb) memDb.close();
  }
});

// ─── /api/rules ──────────────────────────────────────────────────────────
app.get('/api/rules', adminAuth, (_req, res) => {
  const memDb = getMemoryDb();
  if (!memDb) return res.json([]);
  try {
    const rows = memDb.prepare('SELECT id, namespace, category, rule_text, confidence, apply_count, confirmed, created_at FROM rules ORDER BY confidence DESC').all();
    res.json(rows);
  } finally {
    memDb.close();
  }
});

app.post('/api/rules/:id/confirm', adminAuth, (req, res) => {
  let memDb;
  try {
    memDb = new Database(MEMORY_DB_PATH);
    memDb.prepare('UPDATE rules SET confirmed = 1, updated_at = unixepoch() WHERE id = ?').run(req.params.id);
    res.json({ confirmed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memDb) memDb.close();
  }
});

app.delete('/api/rules/:id', adminAuth, (req, res) => {
  let memDb;
  try {
    memDb = new Database(MEMORY_DB_PATH);
    memDb.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memDb) memDb.close();
  }
});

// ─── /api/backup ─────────────────────────────────────────────────────────
app.post('/api/backup', adminAuth, async (_req, res) => {
  let memDb;
  try {
    if (!fs.existsSync(MEMORY_DB_PATH)) return res.status(404).json({ error: 'Memory DB nicht gefunden' });
    fs.mkdirSync(BACKUP_PATH, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const dest = path.join(BACKUP_PATH, `memory-${ts}.db`);
    memDb = new Database(MEMORY_DB_PATH, { readonly: true });
    await memDb.backup(dest);
    res.json({ backup: dest, created: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memDb) memDb.close();
  }
});

// ─── /api/gc ─────────────────────────────────────────────────────────────
app.post('/api/gc', adminAuth, (_req, res) => {
  let memDb;
  try {
    memDb = new Database(MEMORY_DB_PATH);
    const deleted = memDb.prepare('DELETE FROM episodes WHERE quality_score < 0.1').run();
    const dupes   = memDb.prepare(`
      DELETE FROM episodes WHERE id NOT IN (
        SELECT MIN(id) FROM episodes GROUP BY namespace, task_category, context_summary
      )
    `).run();
    memDb.pragma('VACUUM');
    res.json({ deletedWeak: deleted.changes, deletedDupes: dupes.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (memDb) memDb.close();
  }
});

// ─── /api/logs ───────────────────────────────────────────────────────────
app.get('/api/logs', adminAuth, (req, res) => {
  const { lines = 100 } = req.query;
  const parsedLines = Math.max(1, Math.min(1000, parseInt(lines) || 100));
  const memDb = getMemoryDb();
  if (!memDb) return res.json([]);
  try {
    const rows = memDb.prepare(`
      SELECT a.id, a.key_id, k.name as key_name, a.endpoint, a.namespace, a.latency_ms, a.status, a.created_at
      FROM access_log a
      LEFT JOIN api_keys k ON a.key_id = k.id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(parsedLines);
    res.json(rows);
  } finally {
    memDb.close();
  }
});

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────
function syncKeyToMemoryService(id, name, key, scope, namespaces, rateLimit, expiresAt) {
  let memDb;
  try {
    if (!fs.existsSync(MEMORY_DB_PATH)) return;
    memDb = new Database(MEMORY_DB_PATH);
    memDb.prepare(`
      INSERT OR REPLACE INTO api_keys (id, name, key_hash, scope, namespaces, rate_limit, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, key, scope, namespaces, rateLimit, expiresAt || null);
  } catch (e) {
    console.warn('[admin-api] Key-Sync fehlgeschlagen:', e.message);
  } finally {
    if (memDb) memDb.close();
  }
}

function syncKeyRevocation(id) {
  let memDb;
  try {
    if (!fs.existsSync(MEMORY_DB_PATH)) return;
    memDb = new Database(MEMORY_DB_PATH);
    memDb.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  } catch (e) {
    console.warn('[admin-api] Key-Revocation-Sync fehlgeschlagen:', e.message);
  } finally {
    if (memDb) memDb.close();
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[admin-api] Läuft auf Port ${PORT}`);
});

'use strict';
const cron     = require('node-cron');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH          = process.env.DB_PATH          || '/data/graph.db';
const ADMIN_DB_PATH    = process.env.ADMIN_DB_PATH    || '/admin/admin.db';
const BACKUP_PATH      = process.env.BACKUP_PATH      || '/backups';
const MEMCP_URL        = process.env.MEMCP_URL         || 'http://memcp:3457';
const DECAY_FACTOR     = parseFloat(process.env.DECAY_FACTOR     || '0.002');
const MAX_DB_SIZE_MB   = parseInt(process.env.MAX_DB_SIZE_MB     || '500');
const RULE_MIN_NODES   = parseInt(process.env.RULE_MIN_EPISODES  || '3');
const KEY_CLEANUP_DAYS = parseInt(process.env.KEY_CLEANUP_DAYS   || '7');

function log(job, msg) {
  console.log(`[${new Date().toISOString()}] [${job}] ${msg}`);
}

function getDb() {
  if (!fs.existsSync(DB_PATH)) { log('db', 'graph.db nicht gefunden, warte...'); return null; }
  return new Database(DB_PATH);
}

// ─── Garbage Collection ───────────────────────────────────────────────────
function runGC() {
  log('gc', 'Starte Garbage Collection...');
  const db = getDb();
  if (!db) return;
  try {
    const weakDel = db.prepare('DELETE FROM nodes WHERE importance < 0.1').run();
    log('gc', `Schwache Insights geloescht: ${weakDel.changes}`);

    const orphans = db.prepare(`
      DELETE FROM edges WHERE source_id NOT IN (SELECT id FROM nodes)
         OR target_id NOT IN (SELECT id FROM nodes)
    `).run();
    if (orphans.changes > 0) log('gc', `Verwaiste Edges geloescht: ${orphans.changes}`);

    try {
      const orphanEntities = db.prepare(
        'DELETE FROM entity_index WHERE node_id NOT IN (SELECT id FROM nodes)'
      ).run();
      if (orphanEntities.changes > 0) log('gc', `Verwaiste Entity-Eintraege geloescht: ${orphanEntities.changes}`);
    } catch {}

    const dbSize = fs.statSync(DB_PATH).size / 1024 / 1024;
    if (dbSize > MAX_DB_SIZE_MB) {
      log('gc', `DB zu gross (${dbSize.toFixed(1)} MB > ${MAX_DB_SIZE_MB} MB), loesche aelteste Insights...`);
      const oldDel = db.prepare(`
        DELETE FROM nodes WHERE id IN (
          SELECT id FROM nodes ORDER BY created_at ASC LIMIT 100
        )
      `).run();
      log('gc', `Alte Insights geloescht: ${oldDel.changes}`);
    }

    db.pragma('VACUUM');
    const newSize = fs.statSync(DB_PATH).size / 1024 / 1024;
    log('gc', `GC abgeschlossen. DB-Groesse: ${newSize.toFixed(2)} MB`);
  } finally {
    db.close();
  }
}

// ─── Importance-Decay ────────────────────────────────────────────────────
function runDecay() {
  log('decay', 'Starte Importance-Decay...');
  const db = getDb();
  if (!db) return;
  try {
    let result;
    try {
      result = db.prepare(`
        UPDATE nodes
        SET effective_importance = MAX(0, effective_importance - ?)
        WHERE effective_importance > 0
      `).run(DECAY_FACTOR);
    } catch {
      result = db.prepare(`
        UPDATE nodes
        SET importance = MAX(0.05, importance - ?)
        WHERE importance > 0.05
      `).run(DECAY_FACTOR);
    }
    log('decay', `Decay angewendet auf ${result.changes} Insights (Faktor: ${DECAY_FACTOR})`);
  } finally {
    db.close();
  }
}

// ─── Backup ───────────────────────────────────────────────────────────────
async function runBackup() {
  log('backup', 'Starte Backup...');
  const db = getDb();
  if (!db) return;
  try {
    fs.mkdirSync(BACKUP_PATH, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const dest = path.join(BACKUP_PATH, `graph-${ts}.db`);
    await db.backup(dest);
    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
    log('backup', `Backup erstellt: ${dest} (${sizeMB} MB)`);

    const backups = fs.readdirSync(BACKUP_PATH)
      .filter(f => f.startsWith('graph-') && f.endsWith('.db'))
      .sort().reverse();
    backups.slice(7).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_PATH, f));
      log('backup', `Altes Backup geloescht: ${f}`);
    });
  } finally {
    db.close();
  }
}

// ─── Destillierung (Insights → Regeln in admin.db) ──────────────────────
function runDistillation() {
  log('distill', 'Starte Destillierung...');
  const db = getDb();
  if (!db) return;

  if (!fs.existsSync(ADMIN_DB_PATH)) {
    log('distill', 'Admin-DB nicht gefunden, ueberspringe.');
    db.close();
    return;
  }

  const adminDb = new Database(ADMIN_DB_PATH);
  adminDb.pragma('journal_mode = WAL');
  adminDb.exec(`
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

  try {
    const categories = db.prepare(`
      SELECT project, category, COUNT(*) as cnt, AVG(importance) as avg_imp
      FROM nodes
      WHERE category IS NOT NULL AND category != ''
      GROUP BY project, category
      HAVING cnt >= ?
    `).all(RULE_MIN_NODES);

    let created = 0;
    for (const cat of categories) {
      const proj = cat.project || '';
      const existing = adminDb.prepare(
        'SELECT id FROM rules WHERE project = ? AND category = ? LIMIT 1'
      ).get(proj, cat.category);

      if (!existing) {
        const insights = db.prepare(`
          SELECT content, summary FROM nodes
          WHERE (project = ? OR (project IS NULL AND ? = ''))
            AND category = ?
          ORDER BY importance DESC LIMIT 5
        `).all(proj, proj, cat.category);

        const summaries = insights
          .map(n => n.summary || (n.content || '').substring(0, 200))
          .filter(Boolean)
          .join(' | ');

        if (summaries.length > 0) {
          const ruleText = `Bei "${cat.category}"-Aufgaben${proj ? ` (${proj})` : ''}: ${summaries.substring(0, 500)}`;
          adminDb.prepare(`
            INSERT INTO rules (id, project, category, rule_text, confidence, source_count)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            proj,
            cat.category,
            ruleText,
            Math.min(0.9, cat.avg_imp || 0.5),
            cat.cnt
          );
          created++;
        }
      }
    }
    log('distill', `Destillierung abgeschlossen. ${created} neue Regeln erstellt.`);
  } finally {
    db.close();
    adminDb.close();
  }
}

// ─── Key-Cleanup ─────────────────────────────────────────────────────────
function runKeyCleanup() {
  log('key-cleanup', 'Starte Key-Cleanup...');
  if (!fs.existsSync(ADMIN_DB_PATH)) {
    log('key-cleanup', 'Admin-DB nicht gefunden, ueberspringe.');
    return;
  }
  try {
    const adminDb = new Database(ADMIN_DB_PATH);
    const cutoff = Math.floor(Date.now() / 1000) - (KEY_CLEANUP_DAYS * 86400);
    const deleted = adminDb.prepare(
      'DELETE FROM api_keys WHERE active = 0 AND revoked_at IS NOT NULL AND revoked_at < ?'
    ).run(cutoff);
    adminDb.close();
    log('key-cleanup', `${deleted.changes} widerrufene Keys geloescht (aelter als ${KEY_CLEANUP_DAYS} Tage)`);
  } catch (err) {
    log('key-cleanup', `Fehler: ${err.message}`);
  }
}

// ─── Health-Report ───────────────────────────────────────────────────────
async function runHealthReport() {
  try {
    const r = await fetch(`${MEMCP_URL}/mcp/`, { signal: AbortSignal.timeout(5000) });
    log('health', `memcp: ${r.status < 500 ? 'ok' : 'error'} (HTTP ${r.status})`);
  } catch (err) {
    log('health', `Health-Check fehlgeschlagen: ${err.message}`);
  }
}

// ─── Cron-Jobs ──────────────────────────────────────────────────────────
const GC_SCHEDULE      = process.env.GC_SCHEDULE      || '0 2 * * *';
const DISTILL_SCHEDULE = process.env.DISTILL_SCHEDULE || '30 2 * * *';
const BACKUP_SCHEDULE  = process.env.BACKUP_SCHEDULE  || '0 3 * * *';
const DECAY_SCHEDULE   = process.env.DECAY_SCHEDULE   || '0 4 * * *';
const TZ               = process.env.TZ               || 'Europe/Berlin';

function safe(name, fn) {
  return async () => {
    try { await fn(); }
    catch (err) { log(name, `FEHLER: ${err.message}`); }
  };
}

const cronOpts = { timezone: TZ };
cron.schedule(GC_SCHEDULE,      safe('gc',          runGC),           cronOpts);
cron.schedule(DISTILL_SCHEDULE, safe('distill',     runDistillation), cronOpts);
cron.schedule(BACKUP_SCHEDULE,  safe('backup',      runBackup),       cronOpts);
cron.schedule(DECAY_SCHEDULE,   safe('decay',       runDecay),        cronOpts);
cron.schedule('30 4 * * *',     safe('key-cleanup', runKeyCleanup),   cronOpts);
cron.schedule('0 * * * *',      safe('health',      runHealthReport), cronOpts);

// ─── Startup ────────────────────────────────────────────────────────────
log('startup', 'Memory Scheduler gestartet (memcp v2)');
log('startup', `DB: ${DB_PATH} | TZ: ${TZ}`);
log('startup', `GC: ${GC_SCHEDULE} | Destillierung: ${DISTILL_SCHEDULE} | Backup: ${BACKUP_SCHEDULE} | Decay: ${DECAY_SCHEDULE}`);

setTimeout(async () => {
  log('ollama-check', 'Pruefe Ollama-Modell...');
  const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://ollama:11434';
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nomic-embed-text';
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(30000) });
    const data = await r.json();
    const hasModel = data.models?.some(m => m.name.includes('nomic-embed'));
    if (!hasModel) {
      log('ollama-check', `Modell ${OLLAMA_MODEL} nicht gefunden, lade herunter...`);
      await fetch(`${OLLAMA_URL}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: OLLAMA_MODEL, stream: false }),
        signal: AbortSignal.timeout(300000),
      });
      log('ollama-check', `Modell ${OLLAMA_MODEL} heruntergeladen`);
    } else {
      log('ollama-check', `Modell ${OLLAMA_MODEL} ist verfuegbar`);
    }
  } catch (err) {
    log('ollama-check', `Fehler: ${err.message}`);
  }
}, 15000);

'use strict';
const cron     = require('node-cron');
const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH          = process.env.DB_PATH          || '/data/memory.db';
const ADMIN_DB_PATH    = process.env.ADMIN_DB_PATH    || '/admin/admin.db';
const BACKUP_PATH      = process.env.BACKUP_PATH      || '/backups';
const ADMIN_API_URL    = process.env.ADMIN_API_URL    || 'http://admin-api:3459';
const MEMORY_SVC_URL   = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3457';
const ADMIN_API_KEY    = process.env.ADMIN_API_KEY    || '';
const DECAY_FACTOR     = parseFloat(process.env.DECAY_FACTOR     || '0.002');
const MAX_DB_SIZE_MB   = parseInt(process.env.MAX_DB_SIZE_MB     || '500');
const RULE_MIN_EPS     = parseInt(process.env.RULE_MIN_EPISODES  || '3');
const KEY_CLEANUP_DAYS = parseInt(process.env.KEY_CLEANUP_DAYS   || '7');

function log(job, msg) {
  console.log(`[${new Date().toISOString()}] [${job}] ${msg}`);
}

function getDb() {
  if (!fs.existsSync(DB_PATH)) { log('db', 'DB nicht gefunden, warte...'); return null; }
  return new Database(DB_PATH);
}

// ─── Garbage Collection ───────────────────────────────────────────────────
function runGC() {
  log('gc', 'Starte Garbage Collection...');
  const db = getDb();
  if (!db) return;
  try {
    const weakDel = db.prepare('DELETE FROM episodes WHERE quality_score < 0.1').run();
    log('gc', `Schwache Episoden gelöscht: ${weakDel.changes}`);

    const dbSize = fs.statSync(DB_PATH).size / 1024 / 1024;
    if (dbSize > MAX_DB_SIZE_MB) {
      log('gc', `DB zu groß (${dbSize.toFixed(1)} MB > ${MAX_DB_SIZE_MB} MB), lösche älteste Episoden...`);
      const oldDel = db.prepare(`
        DELETE FROM episodes WHERE id IN (
          SELECT id FROM episodes ORDER BY created_at ASC LIMIT 100
        )
      `).run();
      log('gc', `Alte Episoden gelöscht: ${oldDel.changes}`);
    }

    db.pragma('VACUUM');
    const newSize = fs.statSync(DB_PATH).size / 1024 / 1024;
    log('gc', `GC abgeschlossen. DB-Größe: ${newSize.toFixed(2)} MB`);
  } finally {
    db.close();
  }
}

// ─── Score-Decay ──────────────────────────────────────────────────────────
function runDecay() {
  log('decay', 'Starte Score-Decay...');
  const db = getDb();
  if (!db) return;
  try {
    const result = db.prepare(`
      UPDATE episodes
      SET recency_score = MAX(0, recency_score - ?),
          updated_at = unixepoch()
      WHERE recency_score > 0
    `).run(DECAY_FACTOR);
    log('decay', `Score-Decay angewendet auf ${result.changes} Episoden (Faktor: ${DECAY_FACTOR})`);
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
    const dest = path.join(BACKUP_PATH, `memory-${ts}.db`);
    await db.backup(dest);
    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
    log('backup', `Backup erstellt: ${dest} (${sizeMB} MB)`);

    // Alte Backups bereinigen (nur letzte 7 behalten)
    const backups = fs.readdirSync(BACKUP_PATH)
      .filter(f => f.startsWith('memory-') && f.endsWith('.db'))
      .sort().reverse();
    backups.slice(7).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_PATH, f));
      log('backup', `Altes Backup gelöscht: ${f}`);
    });
  } finally {
    db.close();
  }
}

// ─── Destillierung (Episoden → Regeln) ────────────────────────────────────
function runDistillation() {
  log('distill', 'Starte Destillierung...');
  const db = getDb();
  if (!db) return;
  try {
    // Episoden nach Kategorie + Namespace gruppieren
    const categories = db.prepare(`
      SELECT namespace, task_category, COUNT(*) as cnt, AVG(quality_score) as avg_score
      FROM episodes
      WHERE outcome = 'success'
      GROUP BY namespace, task_category
      HAVING cnt >= ?
    `).all(RULE_MIN_EPS);

    let created = 0;
    for (const cat of categories) {
      // Bereits existierende Regel prüfen
      const existing = db.prepare(`
        SELECT id FROM rules
        WHERE namespace = ? AND category = ?
        LIMIT 1
      `).get(cat.namespace, cat.task_category);

      if (!existing) {
        const episodes = db.prepare(`
          SELECT learnings FROM episodes
          WHERE namespace = ? AND task_category = ? AND outcome = 'success'
          ORDER BY quality_score DESC LIMIT 5
        `).all(cat.namespace, cat.task_category);

        const learnings = episodes.map(e => e.learnings).join(' | ');
        const ruleText  = `Bei Aufgaben der Kategorie "${cat.task_category}": ${learnings.substring(0, 300)}`;

        const { v4: uuidv4 } = require('uuid');
        db.prepare(`
          INSERT INTO rules (id, namespace, category, rule_text, confidence, source_episodes, confirmed)
          VALUES (?, ?, ?, ?, ?, '[]', 0)
        `).run(
          require('crypto').randomUUID(),
          cat.namespace,
          cat.task_category,
          ruleText,
          Math.min(0.9, cat.avg_score)
        );
        created++;
      }
    }
    log('distill', `Destillierung abgeschlossen. ${created} neue Regeln erstellt.`);
  } finally {
    db.close();
  }
}

// ─── Key-Cleanup (widerrufene Keys endgültig löschen) ────────────────
function runKeyCleanup() {
  log('key-cleanup', 'Starte Key-Cleanup...');
  if (!fs.existsSync(ADMIN_DB_PATH)) {
    log('key-cleanup', 'Admin-DB nicht gefunden, überspringe.');
    return;
  }
  try {
    const adminDb = new Database(ADMIN_DB_PATH);
    const cutoff = Math.floor(Date.now() / 1000) - (KEY_CLEANUP_DAYS * 86400);
    const deleted = adminDb.prepare(
      'DELETE FROM api_keys WHERE active = 0 AND revoked_at IS NOT NULL AND revoked_at < ?'
    ).run(cutoff);
    adminDb.close();
    log('key-cleanup', `${deleted.changes} widerrufene Keys gelöscht (älter als ${KEY_CLEANUP_DAYS} Tage)`);
  } catch (err) {
    log('key-cleanup', `Fehler: ${err.message}`);
  }
}

// ─── Stündlicher Health-Report ─────────────────────────────────────────────
async function runHealthReport() {
  try {
    const r = await fetch(`${MEMORY_SVC_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    log('health', `Status: ${data.status} | DB: ${data.db} | Ollama: ${data.ollama} | Uptime: ${data.uptime}s`);
  } catch (err) {
    log('health', `Health-Check fehlgeschlagen: ${err.message}`);
  }
}

// ─── Cron-Jobs registrieren ───────────────────────────────────────────────
const GC_SCHEDULE      = process.env.GC_SCHEDULE      || '0 2 * * *';
const DISTILL_SCHEDULE = process.env.DISTILL_SCHEDULE || '30 2 * * *';
const BACKUP_SCHEDULE  = process.env.BACKUP_SCHEDULE  || '0 3 * * *';
const DECAY_SCHEDULE   = process.env.DECAY_SCHEDULE   || '0 4 * * *';

function safe(name, fn) {
  return async () => {
    try { await fn(); }
    catch (err) { log(name, `FEHLER: ${err.message}`); }
  };
}

cron.schedule(GC_SCHEDULE,      safe('gc',          runGC),           { timezone: 'Europe/Berlin' });
cron.schedule(DISTILL_SCHEDULE, safe('distill',     runDistillation), { timezone: 'Europe/Berlin' });
cron.schedule(BACKUP_SCHEDULE,  safe('backup',      runBackup),       { timezone: 'Europe/Berlin' });
cron.schedule(DECAY_SCHEDULE,   safe('decay',       runDecay),        { timezone: 'Europe/Berlin' });
cron.schedule('30 4 * * *',     safe('key-cleanup', runKeyCleanup),   { timezone: 'Europe/Berlin' });
cron.schedule('0 * * * *',      safe('health',      runHealthReport), { timezone: 'Europe/Berlin' });

// ─── Startup ──────────────────────────────────────────────────────────────
log('startup', 'Memory Scheduler gestartet');
log('startup', `GC: ${GC_SCHEDULE} | Destillierung: ${DISTILL_SCHEDULE} | Backup: ${BACKUP_SCHEDULE} | Decay: ${DECAY_SCHEDULE}`);

// Beim Start: Ollama-Modell-Check
setTimeout(async () => {
  log('ollama-check', 'Prüfe Ollama-Modell...');
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
        signal: AbortSignal.timeout(300000), // 5 min
      });
      log('ollama-check', `Modell ${OLLAMA_MODEL} heruntergeladen`);
    } else {
      log('ollama-check', `Modell ${OLLAMA_MODEL} ist verfügbar`);
    }
  } catch (err) {
    log('ollama-check', `Fehler: ${err.message}`);
  }
}, 15000); // 15 Sekunden nach Start

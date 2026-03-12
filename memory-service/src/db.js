'use strict';
const Database = require('better-sqlite3');
const path = require('path');

let db;

function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || '/data/memory.db';
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      key_hash   TEXT NOT NULL UNIQUE,
      scope      TEXT NOT NULL DEFAULT 'recall+store',
      namespaces TEXT NOT NULL DEFAULT '*',
      rate_limit INTEGER NOT NULL DEFAULT 60,
      expires_at INTEGER,
      last_used  INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_by TEXT NOT NULL DEFAULT 'system',
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL DEFAULT 'unknown',
      namespace       TEXT NOT NULL DEFAULT 'global',
      task_category   TEXT NOT NULL,
      outcome         TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')),
      context_summary TEXT NOT NULL,
      learnings       TEXT NOT NULL,
      embedding       BLOB,
      quality_score   REAL NOT NULL DEFAULT 0.5,
      recency_score   REAL NOT NULL DEFAULT 1.0,
      access_count    INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rules (
      id              TEXT PRIMARY KEY,
      namespace       TEXT NOT NULL DEFAULT 'global',
      category        TEXT NOT NULL,
      rule_text       TEXT NOT NULL,
      confidence      REAL NOT NULL DEFAULT 0.5,
      source_episodes TEXT NOT NULL DEFAULT '[]',
      apply_count     INTEGER NOT NULL DEFAULT 0,
      confirmed       INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS access_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id     TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      namespace  TEXT,
      latency_ms INTEGER,
      status     INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_namespace ON episodes(namespace);
    CREATE INDEX IF NOT EXISTS idx_episodes_category  ON episodes(task_category);
    CREATE INDEX IF NOT EXISTS idx_episodes_score     ON episodes(quality_score DESC);
    CREATE INDEX IF NOT EXISTS idx_rules_namespace    ON rules(namespace);
    CREATE INDEX IF NOT EXISTS idx_rules_category     ON rules(category);
    CREATE INDEX IF NOT EXISTS idx_access_log_key     ON access_log(key_id);
  `);

  // Standard-Admin-Key anlegen falls noch keiner vorhanden
  if (!process.env.ADMIN_API_KEY) {
    console.warn('[db] WARNUNG: ADMIN_API_KEY nicht gesetzt! Bitte in .env konfigurieren.');
  }
  const adminKey = process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';
  const existing = db.prepare('SELECT id FROM api_keys WHERE id = ?').get('system-admin');
  if (!existing) {
    db.prepare(`
      INSERT INTO api_keys (id, name, key_hash, scope, namespaces, rate_limit, created_by)
      VALUES ('system-admin', 'System Admin', ?, 'admin', '*', 1000, 'system')
    `).run(adminKey);
  }
}

module.exports = { getDb };

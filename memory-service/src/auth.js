'use strict';
const { getDb } = require('./db');

const rateCounters = new Map(); // keyId -> { count, resetAt }

function checkApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'X-API-Key header fehlt' });

  const db = getDb();
  const record = db.prepare(`
    SELECT * FROM api_keys
    WHERE key_hash = ? AND active = 1
      AND (expires_at IS NULL OR expires_at > unixepoch())
  `).get(key);

  if (!record) return res.status(403).json({ error: 'Ungültiger oder abgelaufener API-Key' });

  // Rate limiting
  const now = Date.now();
  let counter = rateCounters.get(record.id);
  if (!counter || counter.resetAt < now) {
    counter = { count: 0, resetAt: now + 60000 };
    rateCounters.set(record.id, counter);
  }
  counter.count++;
  if (counter.count > record.rate_limit) {
    return res.status(429).json({ error: 'Rate limit überschritten' });
  }

  // Namespace-Check
  const requestedNs = req.body?.namespace || req.query?.namespace || 'global';
  if (record.namespaces !== '*') {
    const allowed = record.namespaces.split(',').map(s => s.trim());
    if (!allowed.includes(requestedNs) && !allowed.some(a => requestedNs.startsWith(a + ':'))) {
      return res.status(403).json({ error: `Namespace '${requestedNs}' nicht erlaubt` });
    }
  }

  // Letzte Nutzung aktualisieren
  db.prepare('UPDATE api_keys SET last_used = unixepoch() WHERE id = ?').run(record.id);

  req.apiKey = record;
  next();
}

function requireScope(scope) {
  return (req, res, next) => {
    const key = req.apiKey;
    if (!key) return res.status(401).json({ error: 'Nicht authentifiziert' });
    if (key.scope === 'admin') return next();
    if (key.scope === scope) return next();
    if (scope === 'recall' && key.scope === 'recall+store') return next();
    if (scope === 'store'  && key.scope === 'recall+store') return next();
    return res.status(403).json({ error: `Scope '${scope}' erforderlich` });
  };
}

module.exports = { checkApiKey, requireScope };

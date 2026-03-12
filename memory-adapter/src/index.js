'use strict';
const cron = require('node-cron');

const MEMORY_SVC_URL    = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3457';
const MEMORY_API_KEY    = process.env.MEMORY_API_KEY     || '';
const ADAPTER_SOURCE    = process.env.ADAPTER_SOURCE     || 'nextcloud';
const ADAPTER_API_URL   = process.env.ADAPTER_API_URL    || '';
const ADAPTER_API_KEY   = process.env.ADAPTER_API_KEY    || '';
const SYNC_SCHEDULE     = process.env.ADAPTER_SYNC_SCHEDULE || '0 */6 * * *';
const NAMESPACES        = (process.env.ADAPTER_NAMESPACES || 'business:projects').split(',');
const FILTER_FIELDS     = (process.env.ADAPTER_FILTER_FIELDS || '').split(',').filter(Boolean);
const MAX_AGE_DAYS      = parseInt(process.env.ADAPTER_MAX_AGE_DAYS || '90');

function log(msg) {
  console.log(`[${new Date().toISOString()}] [adapter:${ADAPTER_SOURCE}] ${msg}`);
}

async function storeMemory(experience, namespace) {
  const res = await fetch(`${MEMORY_SVC_URL}/mcp/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': MEMORY_API_KEY },
    body: JSON.stringify({ experience, namespace }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Store fehlgeschlagen: ${res.status}`);
  return res.json();
}

function filterFields(obj) {
  if (!FILTER_FIELDS.length) return obj;
  const filtered = { ...obj };
  FILTER_FIELDS.forEach(f => delete filtered[f.trim()]);
  return filtered;
}

// ─── Source-spezifische Sync-Funktionen ──────────────────────────────────

async function syncNextcloud() {
  log('Starte Nextcloud-Sync...');
  if (!ADAPTER_API_URL || !ADAPTER_API_KEY) {
    log('ADAPTER_API_URL oder ADAPTER_API_KEY nicht gesetzt, überspringe.');
    return;
  }
  try {
    const since = new Date(Date.now() - MAX_AGE_DAYS * 86400 * 1000).toISOString();
    const res = await fetch(`${ADAPTER_API_URL}/ocs/v2.php/apps/activity/api/v2/activity?since=${since}&format=json`, {
      headers: { 'OCS-APIREQUEST': 'true', 'Authorization': 'Basic ' + Buffer.from(`admin:${ADAPTER_API_KEY}`).toString('base64') },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { log(`Nextcloud API Fehler: ${res.status}`); return; }
    const data = await res.json();
    const activities = data?.ocs?.data || [];
    let stored = 0;
    for (const act of activities.slice(0, 50)) {
      try {
        const experience = filterFields({
          task_category: `nextcloud:${act.type || 'activity'}`,
          outcome: 'success',
          context_summary: act.subject || act.message || 'Nextcloud Aktivität',
          learnings: `Datei: ${act.object_name || '—'} | Nutzer: ${act.user || '—'}`,
        });
        await storeMemory(experience, NAMESPACES[0] || 'business:nextcloud');
        stored++;
      } catch {}
    }
    log(`${stored} Nextcloud-Aktivitäten gespeichert`);
  } catch (err) {
    log(`Sync-Fehler: ${err.message}`);
  }
}

async function syncGitea() {
  log('Starte Gitea-Sync...');
  if (!ADAPTER_API_URL || !ADAPTER_API_KEY) {
    log('ADAPTER_API_URL oder ADAPTER_API_KEY nicht gesetzt, überspringe.');
    return;
  }
  try {
    const res = await fetch(`${ADAPTER_API_URL}/api/v1/repos/search?limit=20`, {
      headers: { 'Authorization': `token ${ADAPTER_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { log(`Gitea API Fehler: ${res.status}`); return; }
    const data = await res.json();
    const repos = data.data || [];
    let stored = 0;
    for (const repo of repos) {
      try {
        await storeMemory(filterFields({
          task_category: 'gitea:repository',
          outcome: 'success',
          context_summary: `Repository: ${repo.full_name} - ${repo.description || 'Keine Beschreibung'}`,
          learnings: `Sprache: ${repo.language || '—'} | Stars: ${repo.stars_count || 0} | Letztes Update: ${repo.updated}`,
        }), NAMESPACES[0] || 'business:git');
        stored++;
      } catch {}
    }
    log(`${stored} Gitea-Repositories gespeichert`);
  } catch (err) {
    log(`Sync-Fehler: ${err.message}`);
  }
}

async function syncCustom() {
  log('Custom-Sync: Bitte src/adapters/custom.js implementieren');
}

// ─── Dispatch ─────────────────────────────────────────────────────────────
async function runSync() {
  log(`Sync gestartet (Quelle: ${ADAPTER_SOURCE})`);
  switch (ADAPTER_SOURCE) {
    case 'nextcloud': await syncNextcloud(); break;
    case 'gitea':     await syncGitea();     break;
    case 'custom':    await syncCustom();    break;
    default:          log(`Unbekannte Quelle: ${ADAPTER_SOURCE}`);
  }
  log('Sync abgeschlossen');
}

// ─── Cron ─────────────────────────────────────────────────────────────────
cron.schedule(SYNC_SCHEDULE, runSync, { timezone: 'Europe/Berlin' });
log(`Adapter gestartet. Sync-Schedule: ${SYNC_SCHEDULE} | Quelle: ${ADAPTER_SOURCE}`);

// Initialer Sync nach 30 Sekunden
setTimeout(runSync, 30000);

'use strict';
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');
const {
  getEmbedding, cosineSimilarity,
  embeddingToBuffer, bufferToEmbedding
} = require('./embedding');

const MAX_RECALL_TOKENS  = parseInt(process.env.MAX_RECALL_TOKENS  || '450');
const SIM_THRESHOLD      = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.75');
const MAX_RESULTS_L2     = parseInt(process.env.MAX_RESULTS_L2 || '3');
const MAX_RULES_L3       = parseInt(process.env.MAX_RULES_L3   || '5');

// ─── Recall ────────────────────────────────────────────────────────────────
async function recall(taskDescription, namespace, sharedNamespaces = []) {
  const db = getDb();
  const allNamespaces = [namespace, ...sharedNamespaces, 'global'].filter((v, i, a) => a.indexOf(v) === i);

  let queryEmbedding = null;
  try {
    queryEmbedding = await getEmbedding(taskDescription);
  } catch (e) {
    console.warn('[memory] Embedding fehlgeschlagen, Fallback auf Text-Suche:', e.message);
  }

  // L3: Prozedurales Wissen (Regeln)
  const nsPlaceholders = allNamespaces.map(() => '?').join(',');
  const rules = db.prepare(`
    SELECT id, category, rule_text, confidence, apply_count
    FROM rules
    WHERE namespace IN (${nsPlaceholders}) AND confirmed = 1
    ORDER BY confidence DESC, apply_count DESC
    LIMIT ?
  `).all(...allNamespaces, MAX_RULES_L3 * 2);

  // L2: Episodisches Wissen mit Similarity-Ranking
  const episodes = db.prepare(`
    SELECT id, task_category, outcome, context_summary, learnings,
           embedding, quality_score, recency_score, created_at
    FROM episodes
    WHERE namespace IN (${nsPlaceholders})
    ORDER BY (quality_score * 0.4 + recency_score * 0.3) DESC
    LIMIT 50
  `).all(...allNamespaces);

  let scoredEpisodes = episodes.map(ep => {
    const emb = bufferToEmbedding(ep.embedding);
    const sim = queryEmbedding && emb ? cosineSimilarity(queryEmbedding, emb) : 0;
    const combined = sim * 0.3 + ep.quality_score * 0.4 + ep.recency_score * 0.3;
    return { ...ep, similarity: sim, combined };
  });

  scoredEpisodes = scoredEpisodes
    .filter(ep => !queryEmbedding || ep.similarity >= SIM_THRESHOLD || ep.similarity === 0)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, MAX_RESULTS_L2);

  // Access-Count erhöhen
  if (scoredEpisodes.length > 0) {
    const updateStmt = db.prepare('UPDATE episodes SET access_count = access_count + 1 WHERE id = ?');
    const updateMany = db.transaction(eps => eps.forEach(ep => updateStmt.run(ep.id)));
    updateMany(scoredEpisodes);
  }

  // L3 apply_count
  if (rules.length > 0) {
    const ruleStmt = db.prepare('UPDATE rules SET apply_count = apply_count + 1 WHERE id = ?');
    const updateRules = db.transaction(rs => rs.forEach(r => ruleStmt.run(r.id)));
    updateRules(rules.slice(0, MAX_RULES_L3));
  }

  return formatRecall(rules.slice(0, MAX_RULES_L3), scoredEpisodes, taskDescription);
}

function formatRecall(rules, episodes, query) {
  const parts = [];

  if (rules.length > 0) {
    parts.push('## Gelernte Regeln');
    rules.forEach(r => {
      parts.push(`- [${r.category}] ${r.rule_text} (Konfidenz: ${(r.confidence * 100).toFixed(0)}%)`);
    });
  }

  if (episodes.length > 0) {
    parts.push('\n## Relevante Erfahrungen');
    episodes.forEach(ep => {
      parts.push(`### ${ep.task_category} (${ep.outcome})`);
      parts.push(`Kontext: ${ep.context_summary}`);
      parts.push(`Erkenntnisse: ${ep.learnings}`);
    });
  }

  if (parts.length === 0) {
    return { context: '', episodeCount: 0, ruleCount: 0, tokenEstimate: 0 };
  }

  const context = parts.join('\n');
  const tokenEstimate = Math.ceil(context.length / 4);
  const truncated = tokenEstimate > MAX_RECALL_TOKENS
    ? context.substring(0, MAX_RECALL_TOKENS * 4) + '\n[...gekürzt]'
    : context;

  return {
    context: truncated,
    episodeCount: episodes.length,
    ruleCount: rules.length,
    tokenEstimate: Math.min(tokenEstimate, MAX_RECALL_TOKENS)
  };
}

// ─── Store ─────────────────────────────────────────────────────────────────
async function store(experience, namespace, agentId = 'unknown') {
  const { task_category, outcome, context_summary, learnings } = experience;
  if (!task_category || !outcome || !context_summary || !learnings) {
    throw new Error('Pflichtfelder: task_category, outcome, context_summary, learnings');
  }

  let embedding = null;
  try {
    const text = `${task_category} ${context_summary} ${learnings}`;
    const vec = await getEmbedding(text);
    embedding = embeddingToBuffer(vec);
  } catch (e) {
    console.warn('[memory] Embedding beim Store fehlgeschlagen:', e.message);
  }

  const id = uuidv4();
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes
      (id, agent_id, namespace, task_category, outcome, context_summary, learnings, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, namespace, task_category, outcome, context_summary, learnings, embedding);

  return { id, stored: true };
}

// ─── Feedback ──────────────────────────────────────────────────────────────
function feedback(episodeId, success) {
  const db = getDb();
  const ep = db.prepare('SELECT quality_score FROM episodes WHERE id = ?').get(episodeId);
  if (!ep) throw new Error(`Episode ${episodeId} nicht gefunden`);

  const delta = success ? 0.1 : -0.15;
  const newScore = Math.max(0, Math.min(1, ep.quality_score + delta));
  db.prepare('UPDATE episodes SET quality_score = ?, updated_at = unixepoch() WHERE id = ?')
    .run(newScore, episodeId);

  return { id: episodeId, newScore };
}

// ─── Stats ─────────────────────────────────────────────────────────────────
function getStats() {
  const db = getDb();
  const episodeCount = db.prepare('SELECT COUNT(*) as c FROM episodes').get().c;
  const ruleCount    = db.prepare('SELECT COUNT(*) as c FROM rules WHERE confirmed = 1').get().c;
  const avgScore     = db.prepare('SELECT AVG(quality_score) as s FROM episodes').get().s || 0;
  const hits         = db.prepare('SELECT COUNT(*) as c FROM episodes WHERE access_count > 0').get().c;
  const hitRate      = episodeCount > 0 ? hits / episodeCount : 0;

  return { episodeCount, ruleCount, avgScore: avgScore.toFixed(3), hitRate: hitRate.toFixed(3) };
}

module.exports = { recall, store, feedback, getStats };

'use strict';

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nomic-embed-text';

async function getEmbedding(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
  const data = await res.json();
  return data.embedding; // float[]
}

async function isOllamaReady() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function embeddingToBuffer(embedding) {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

function bufferToEmbedding(buf) {
  if (!buf) return null;
  const arr = [];
  for (let i = 0; i < buf.length; i += 4) {
    arr.push(buf.readFloatLE(i));
  }
  return arr;
}

module.exports = { getEmbedding, isOllamaReady, cosineSimilarity, embeddingToBuffer, bufferToEmbedding };

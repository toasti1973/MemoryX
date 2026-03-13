#!/usr/bin/env python3
"""Datenmigration: MemoryX v1 (memory.db) → MemoryX v2 (memcp graph.db).

Migriert Episoden aus dem alten Schema in das MAGMA-Graph-Format von memcp.

Quell-Schema (memory.db):
  episodes: id, agent_id, namespace, task_category, outcome, context_summary,
            learnings, quality_score, recency_score, access_count, created_at

Ziel-Schema (graph.db):
  nodes: id, content, summary, category, importance, effective_importance,
         tags, entities, project, session, token_count, access_count,
         last_accessed_at, created_at, feedback_score

Usage:
  python migrate.py --source /data/memory.db --target /data/graph.db [--dry-run]
"""

import argparse
import json
import sqlite3
import sys
import uuid
from datetime import datetime


def estimate_tokens(text: str) -> int:
    """Grobe Token-Schaetzung: ~4 Zeichen pro Token."""
    return max(1, len(text) // 4)


def quality_to_importance(quality_score: float, outcome: str) -> float:
    """Konvertiert quality_score (0-1) in importance (0-1)."""
    base = quality_score
    if outcome == "failure":
        base = max(base, 0.6)  # Failures sind immer wichtig (Warnungen)
    elif outcome == "success":
        base = max(base, 0.3)
    return round(min(1.0, base), 3)


def namespace_to_project(namespace: str) -> str:
    """Konvertiert MemoryX-Namespace in memcp-Projektnamen."""
    if namespace.startswith("project:"):
        return namespace.split(":", 1)[1]
    if namespace == "global":
        return "global"
    return namespace


def migrate(source_path: str, target_path: str, dry_run: bool = False):
    """Migriert Episoden von memory.db nach graph.db."""
    print(f"[migrate] Quelle: {source_path}")
    print(f"[migrate] Ziel:   {target_path}")
    print(f"[migrate] Modus:  {'DRY-RUN' if dry_run else 'LIVE'}")
    print()

    # Quell-DB oeffnen
    src = sqlite3.connect(source_path)
    src.row_factory = sqlite3.Row

    episodes = src.execute("""
        SELECT id, agent_id, namespace, task_category, outcome,
               context_summary, learnings, quality_score, recency_score,
               access_count, created_at
        FROM episodes
        ORDER BY created_at ASC
    """).fetchall()

    print(f"[migrate] {len(episodes)} Episoden gefunden")

    if not episodes:
        print("[migrate] Nichts zu migrieren.")
        src.close()
        return

    if dry_run:
        for ep in episodes:
            project = namespace_to_project(ep["namespace"])
            importance = quality_to_importance(ep["quality_score"], ep["outcome"])
            print(f"  [{ep['id'][:8]}] {ep['task_category']} ({ep['outcome']}) "
                  f"→ project={project}, importance={importance}")
        src.close()
        print(f"\n[migrate] DRY-RUN: {len(episodes)} Episoden wuerden migriert.")
        return

    # Ziel-DB oeffnen und Schema sicherstellen
    tgt = sqlite3.connect(target_path)
    tgt.execute("PRAGMA journal_mode=WAL")
    tgt.execute("PRAGMA foreign_keys=ON")

    # memcp nodes-Tabelle erstellen falls noetig
    tgt.execute("""
        CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'general',
            importance REAL NOT NULL DEFAULT 0.5,
            effective_importance REAL NOT NULL DEFAULT 0.5,
            tags TEXT NOT NULL DEFAULT '[]',
            entities TEXT NOT NULL DEFAULT '[]',
            project TEXT NOT NULL DEFAULT 'default',
            session TEXT NOT NULL DEFAULT '',
            token_count INTEGER NOT NULL DEFAULT 0,
            access_count INTEGER NOT NULL DEFAULT 0,
            last_accessed_at TEXT,
            created_at TEXT NOT NULL,
            feedback_score REAL NOT NULL DEFAULT 0.0
        )
    """)

    tgt.execute("""
        CREATE TABLE IF NOT EXISTS edges (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            edge_type TEXT NOT NULL CHECK(edge_type IN ('semantic','temporal','causal','entity')),
            weight REAL NOT NULL DEFAULT 0.5,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            last_activated_at TEXT,
            PRIMARY KEY (source_id, target_id, edge_type)
        )
    """)

    tgt.execute("""
        CREATE TABLE IF NOT EXISTS entity_index (
            entity TEXT NOT NULL,
            node_id TEXT NOT NULL,
            PRIMARY KEY (entity, node_id)
        )
    """)

    migrated = 0
    skipped = 0

    for ep in episodes:
        # Pruefen ob bereits migriert (gleiche ID)
        existing = tgt.execute("SELECT id FROM nodes WHERE id = ?", (ep["id"],)).fetchone()
        if existing:
            skipped += 1
            continue

        project = namespace_to_project(ep["namespace"])
        importance = quality_to_importance(ep["quality_score"], ep["outcome"])
        content = f"[{ep['outcome'].upper()}] {ep['context_summary']}\n\nLearnings: {ep['learnings']}"
        summary = ep["context_summary"][:200]
        tags = json.dumps([ep["task_category"], ep["outcome"], ep["namespace"]])
        entities = json.dumps([ep["agent_id"]] if ep["agent_id"] != "unknown" else [])
        token_count = estimate_tokens(content)
        created_at = datetime.fromtimestamp(ep["created_at"]).isoformat() if ep["created_at"] else datetime.now().isoformat()

        tgt.execute("""
            INSERT INTO nodes (id, content, summary, category, importance, effective_importance,
                             tags, entities, project, session, token_count, access_count,
                             last_accessed_at, created_at, feedback_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ep["id"],
            content,
            summary,
            ep["task_category"],
            importance,
            importance,
            tags,
            entities,
            project,
            "",  # session — nicht verfuegbar in altem Schema
            token_count,
            ep["access_count"],
            created_at,
            created_at,
            0.0,
        ))
        migrated += 1

    tgt.commit()
    tgt.close()
    src.close()

    print(f"\n[migrate] Abgeschlossen:")
    print(f"  Migriert:    {migrated}")
    print(f"  Uebersprungen: {skipped} (bereits vorhanden)")
    print(f"  Gesamt:      {len(episodes)}")
    print(f"\n[migrate] HINWEIS: Embeddings muessen neu berechnet werden.")
    print(f"          memcp erledigt das automatisch beim ersten Recall/Search.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MemoryX v1 → v2 Datenmigration")
    parser.add_argument("--source", default="/data/memory.db", help="Pfad zur alten memory.db")
    parser.add_argument("--target", default="/data/graph.db", help="Pfad zur neuen graph.db")
    parser.add_argument("--dry-run", action="store_true", help="Nur anzeigen, nichts aendern")
    args = parser.parse_args()

    migrate(args.source, args.target, args.dry_run)

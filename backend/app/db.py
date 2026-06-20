"""Catalogue SQLite : connexion partagée, WAL, verrou d'écriture."""
import json
import sqlite3
import threading
from datetime import datetime
from typing import Any, Optional

from . import config

_conn: Optional[sqlite3.Connection] = None
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  relpath TEXT NOT NULL,
  hash TEXT UNIQUE NOT NULL,
  ext TEXT NOT NULL,
  is_raw INTEGER NOT NULL DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  captured_at TEXT DEFAULT '',
  imported_at TEXT NOT NULL,
  camera TEXT DEFAULT '',
  lens TEXT DEFAULT '',
  iso INTEGER DEFAULT 0,
  aperture REAL DEFAULT 0,
  shutter TEXT DEFAULT '',
  focal REAL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,
  flag TEXT NOT NULL DEFAULT 'none',
  color TEXT NOT NULL DEFAULT '',
  edits TEXT NOT NULL DEFAULT '{}',
  edited INTEGER NOT NULL DEFAULT 0,
  history TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at);
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  settings TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS album_photos (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (album_id, photo_id)
);
"""


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.ensure_dirs()
        _conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        with _conn:
            _conn.executescript(SCHEMA)
            _migrate(_conn)
    return _conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Migrations légères : colonne project_id + projet par défaut (catalogue → projets)."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(photos)")]
    if "project_id" not in cols:
        conn.execute("ALTER TABLE photos ADD COLUMN project_id INTEGER")
    # Colonne `edited` : calculée une fois ici puis maintenue au save, pour éviter de
    # recalculer `edits_meaningful` (deepcopy) à chaque listing du catalogue.
    # Historique des étapes de développement (panneau « Historique »), persisté par photo.
    if "history" not in cols:
        conn.execute("ALTER TABLE photos ADD COLUMN history TEXT NOT NULL DEFAULT '{}'")
    if "edited" not in cols:
        conn.execute("ALTER TABLE photos ADD COLUMN edited INTEGER NOT NULL DEFAULT 0")
        from . import pipeline
        updates = []
        for r in conn.execute("SELECT id, edits FROM photos").fetchall():
            try:
                parsed = json.loads(r[1] or "{}")
            except json.JSONDecodeError:
                parsed = {}
            updates.append((1 if pipeline.edits_meaningful(parsed) else 0, r[0]))
        if updates:
            conn.executemany("UPDATE photos SET edited=? WHERE id=?", updates)
    # Toujours garder au moins un projet (la « maison » des photos existantes)
    row = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()
    if row is None:
        cur = conn.execute("INSERT INTO projects (name, created_at) VALUES (?, ?)",
                           ("Projet par défaut", datetime.now().isoformat()))
        default_id = cur.lastrowid
    else:
        default_id = row[0]
    conn.execute("UPDATE photos SET project_id=? WHERE project_id IS NULL", (default_id,))


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    # La connexion est partagée entre threads (endpoints sync dans le threadpool) :
    # on sérialise AUSSI les lectures, sinon des execute() concurrents entremêlent
    # les curseurs et un fetch peut renvoyer None (→ faux 404). Le verrou n'est tenu
    # que le temps de la requête, jamais pendant le calcul du pipeline.
    with _lock:
        return get_conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
    with _lock:
        return get_conn().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> int:
    """Écriture sérialisée ; renvoie lastrowid."""
    conn = get_conn()
    with _lock, conn:
        cur = conn.execute(sql, params)
        return cur.lastrowid or 0


def executemany(sql: str, seq: list[tuple]) -> None:
    """Écriture batch sérialisée (une seule transaction)."""
    conn = get_conn()
    with _lock, conn:
        conn.executemany(sql, seq)


def photo_to_dict(row: sqlite3.Row, with_edits: bool = False) -> dict[str, Any]:
    d = {k: row[k] for k in row.keys()}
    # `edited` lu depuis la colonne persistée (plus de deepcopy/compare au listing).
    d["edited"] = bool(d.get("edited", 0))
    # `history` n'est servi qu'avec les edits (détail photo), jamais dans le listing du catalogue.
    history_raw = d.pop("history", None)
    if with_edits:
        try:
            d["edits"] = json.loads(row["edits"] or "{}")
        except json.JSONDecodeError:
            d["edits"] = {}
        try:
            d["history"] = json.loads(history_raw or "{}")
        except (json.JSONDecodeError, TypeError):
            d["history"] = {}
    else:
        d.pop("edits", None)
    d.pop("relpath", None)
    d.pop("hash", None)
    return d


def reset_for_tests() -> None:
    """Ferme la connexion (les tests changent DATA_DIR)."""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None

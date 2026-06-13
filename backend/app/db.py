"""Catalogue SQLite : connexion partagée, WAL, verrou d'écriture."""
import json
import sqlite3
import threading
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
  edits TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at);
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  settings TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
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
    return _conn


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return get_conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
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
    if with_edits:
        try:
            d["edits"] = json.loads(d.get("edits") or "{}")
        except json.JSONDecodeError:
            d["edits"] = {}
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

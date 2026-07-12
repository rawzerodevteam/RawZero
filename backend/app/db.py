"""Catalogue SQLite : connexion partagée, WAL, verrou d'écriture."""
import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from . import config

_conn: Optional[sqlite3.Connection] = None
_lock = threading.Lock()

# O3 — séparation lecture/écriture. L'écriture passe par la connexion unique `_conn`
# sérialisée par `_lock` ; la lecture utilise une connexion **par thread** (thread-local)
# en WAL, où les lecteurs ne bloquent pas (ni ne sont bloqués par) l'écrivain. Plus de
# verrou global sur les lectures ⇒ l'UI n'attend plus derrière un export / refresh de previews.
# Chaque thread a sa propre connexion → pas d'entrelacement de curseurs (le risque qui
# imposait jusqu'ici de sérialiser aussi les lectures sur la connexion partagée).
_read_local = threading.local()
_read_conns: list[sqlite3.Connection] = []
_read_conns_lock = threading.Lock()
_db_generation = 0   # incrémenté à reset_for_tests : invalide les conns de lecture héritées

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
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
    # Import par référence de chemin (plus de copie dans data/originals) : la colonne
    # `relpath` (chemin relatif à ORIGINALS_DIR) devient `path` (chemin absolu quelconque
    # sur le disque). Les photos déjà cataloguées (copiées) sont absolutisées vers leur
    # copie existante sous ORIGINALS_DIR : elles continuent de fonctionner à l'identique.
    if "path" not in cols and "relpath" in cols:
        conn.execute("ALTER TABLE photos RENAME COLUMN relpath TO path")
        rows = conn.execute("SELECT id, path FROM photos").fetchall()
        updates = []
        for photo_id, rel in rows:
            if rel and not Path(rel).is_absolute():
                updates.append((str((config.ORIGINALS_DIR / rel).resolve()), photo_id))
        if updates:
            conn.executemany("UPDATE photos SET path=? WHERE id=?", updates)
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
    # Index du listing courant (filtre projet + tri/borne captured_at, cf. B6) : créé ici
    # car project_id est ajouté par migration (absent du CREATE TABLE).
    conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_project_captured "
                 "ON photos(project_id, captured_at, id)")


def _read_conn() -> sqlite3.Connection:
    """Connexion de lecture propre au thread courant (WAL, pas de verrou global)."""
    get_conn()                     # garantit schéma + migrations (sur la connexion d'écriture)
    conn: Optional[sqlite3.Connection] = getattr(_read_local, "conn", None)
    if conn is not None and getattr(_read_local, "gen", -1) != _db_generation:
        try:
            conn.close()
        except Exception:
            pass
        conn = None
    if conn is None:
        conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _read_local.conn = conn
        _read_local.gen = _db_generation
        with _read_conns_lock:
            _read_conns.append(conn)
    return conn


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return _read_conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
    return _read_conn().execute(sql, params).fetchone()


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
    # `path` : import par référence (pas de copie) → exposé au client (app locale
    # mono-utilisateur, utile pour le badge/relink « fichier introuvable »).
    if "path" in d:
        d["missing"] = not Path(d["path"]).is_file()
    d.pop("hash", None)
    return d


def reset_for_tests() -> None:
    """Ferme les connexions (les tests changent DATA_DIR)."""
    global _conn, _db_generation
    if _conn is not None:
        _conn.close()
        _conn = None
    with _read_conns_lock:
        for c in _read_conns:
            try:
                c.close()
            except Exception:
                pass
        _read_conns.clear()
    # Invalide les connexions de lecture héritées par d'autres threads (recréées au prochain accès).
    _db_generation += 1

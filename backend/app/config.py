"""Chemins et constantes, surchargeables par variables d'environnement."""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()
IMPORT_DIR = Path(os.environ.get("IMPORT_DIR", "./import")).resolve()
STATIC_DIR = os.environ.get("STATIC_DIR", "")

ORIGINALS_DIR = DATA_DIR / "originals"
THUMBS_DIR = DATA_DIR / "cache" / "thumbs"
PREVIEWS_DIR = DATA_DIR / "cache" / "previews"
BASE_DIR = DATA_DIR / "cache" / "base"
MASKS_DIR = DATA_DIR / "cache" / "masks"   # masques IA rasterisés (PNG mono-canal)
MODELS_DIR = DATA_DIR / "models"           # modèles ONNX (déposés manuellement)
EXPORTS_DIR = DATA_DIR / "exports"
DB_PATH = DATA_DIR / "catalog.db"

THUMB_SIZE = 360          # bord long des vignettes de grille
PREVIEW_SIZE = 2048       # bord long des previews de tri (loupe)
BASE_SIZE = 2560          # bord long de la base de développement (cache .npy float16)

RAW_EXTS = {".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".raf", ".orf",
            ".rw2", ".dng", ".pef", ".srw", ".x3f", ".3fr", ".fff", ".iiq", ".kdc",
            ".mrw", ".raw", ".rwl", ".erf", ".mef", ".mos"}
IMG_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".bmp"}


def ensure_dirs() -> None:
    for d in (ORIGINALS_DIR, THUMBS_DIR, PREVIEWS_DIR, BASE_DIR, MASKS_DIR, EXPORTS_DIR):
        d.mkdir(parents=True, exist_ok=True)

"""Isole DATA_DIR dans un dossier temporaire AVANT l'import de l'app."""
import os
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="rawzero-test-")
os.environ["DATA_DIR"] = str(Path(_tmp) / "data")
os.environ.pop("STATIC_DIR", None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

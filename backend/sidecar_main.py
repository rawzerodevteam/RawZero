"""Point d'entrée du sidecar Tauri : sert l'API FastAPI + le frontend buildé sur un port local.

Lancé en binaire figé (PyInstaller) par le shell Tauri (src-tauri/src/main.rs), qui définit
DATA_DIR / IMPORT_DIR / STATIC_DIR / PORT avant de spawn ce process, puis attend que
/api/health réponde avant d'ouvrir la fenêtre.
"""
import os
import sys

# Build fenêtré (PyInstaller console=False) : sys.stdout/stderr valent None. Le logging
# d'uvicorn (et de la stdlib) appelle .isatty()/.write() dessus → crash. On les redirige
# vers le vide AVANT d'importer app.main, qui configure déjà le logging.
for _name in ("stdout", "stderr"):
    if getattr(sys, _name) is None:
        setattr(sys, _name, open(os.devnull, "w"))

import uvicorn  # noqa: E402

from app.main import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

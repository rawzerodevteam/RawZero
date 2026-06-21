"""Point d'entrée du sidecar Tauri : sert l'API FastAPI + le frontend buildé sur un port local.

Lancé en binaire figé (PyInstaller) par le shell Tauri (src-tauri/src/main.rs), qui définit
DATA_DIR / IMPORT_DIR / STATIC_DIR / PORT avant de spawn ce process, puis attend que
/api/health réponde avant d'ouvrir la fenêtre.
"""
import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

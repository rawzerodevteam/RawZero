#!/usr/bin/env bash
# Build complet de l'app desktop Tauri : sidecar backend (PyInstaller) + frontend (Vite)
# + bundle Tauri (.deb/.rpm). À relancer après toute modif de backend/app ou frontend/src.
#
# --clean : purge le cache de build Rust des crates Tauri (chemins absolus périmés si le
# dossier projet a été déplacé/renommé depuis le dernier build — issue #21), avant de builder.
set -euo pipefail
# Ce script vit dans scripts/ ; on opère depuis la racine du dépôt (dossier parent).
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--clean" ]]; then
  echo "== --clean : purge du cache de build Tauri (chemins absolus périmés) =="
  rm -rf src-tauri/target/debug/build/tauri-* src-tauri/target/debug/build/app-*
  rm -rf src-tauri/target/release/build/tauri-* src-tauri/target/release/build/app-*
fi

echo "== 1/3 : sidecar backend (PyInstaller) =="
( cd backend && .venv/bin/pyinstaller --noconfirm rawzero-backend.spec )

echo "== 2/3 : frontend (Vite) =="
( cd frontend && npm run build )

echo "== 3/3 : bundle Tauri (.deb/.rpm/AppImage) =="
source "$HOME/.cargo/env"
npx --prefix frontend tauri build

echo
echo "Bundle prêt : src-tauri/target/release/bundle/deb/"
ls -la src-tauri/target/release/bundle/deb/*.deb 2>/dev/null || true

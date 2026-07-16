"""Téléchargement à la demande des modèles IA (segmentation du sujet, clic EdgeSAM, débruitage).

Les modèles ONNX ne sont pas embarqués dans l'app (installeur léger) : l'utilisateur les
télécharge depuis l'interface, ils atterrissent dans MODELS_DIR. Le reste de l'app fonctionne
sans eux (les features concernées sont juste indisponibles, cf. segment.py / denoise.py).

Manifest = source unique de vérité. Ajouter une feature ou un fichier = éditer FEATURES.
Tous les modèles sont hébergés sur UN dépôt GitHub sous notre contrôle (release), avec
taille **et** SHA-256 épinglés : un fichier altéré/corrompu (même d'un octet) est rejeté
avant d'être installé, donc la fiabilité de la source importe peu — seul le contenu compte.
"""
import hashlib
import logging
import os
import threading
import urllib.request
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, denoise, segment

log = logging.getLogger(__name__)
router = APIRouter()


@dataclass(frozen=True)
class ModelFile:
    name: str
    size: int    # octets attendus ; 0 = taille inconnue (pas de vérif)
    sha256: str  # empreinte SHA-256 attendue (hex minuscule) ; "" = pas de vérif


# URL de base d'hébergement des modèles (repo GitHub PUBLIC à nous, fichiers à la racine de la
# branche par défaut → servis en brut via raw.githubusercontent.com). Surchargeable par env
# (RAWZERO_MODELS_URL) pour pointer un autre repo/branche sans rebuild. URL fichier = {base}/{nom}.
MODELS_BASE_URL = os.environ.get(
    "RAWZERO_MODELS_URL",
    "https://raw.githubusercontent.com/rawzerodevteam/RawZeroModelsDownload/main",
).rstrip("/")


def _url(name: str) -> str:
    return f"{MODELS_BASE_URL}/{name}"


# Délai réseau (connexion et chaque lecture de socket). Sans lui, une connexion qui « pend »
# bloque le thread daemon à vie, laisse `downloading: true` en permanence et interdit tout
# re-téléchargement (garde 409). Surchargeable par env. Cf. S3 de l'audit.
DOWNLOAD_TIMEOUT = float(os.environ.get("RAWZERO_DOWNLOAD_TIMEOUT", "30"))


# Manifest en dur (3 features). Les noms de fichiers viennent de segment.py / denoise.py (source
# unique) : renommer un modèle là-bas suffit, téléchargement et dispo suivent. Taille + SHA-256
# vérifiés à l'octet contre les fichiers de référence locaux.
FEATURES: dict[str, list[ModelFile]] = {
    "subject": [
        ModelFile(segment.model_path().name, 4574861,
                  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"),
    ],
    "point": [
        ModelFile(segment.sam_encoder_path().name, 22098300,
                  "719a498cf5b3fe9be9f01ee513e13d3915f9028aa4f23dfd30eaaa0a17143159"),
        ModelFile(segment.sam_decoder_path().name, 15937006,
                  "83a2174d54571596913dcb7455d021e713623c3dca30a31c8c41ab98c9fb0863"),
    ],
    "denoise": [
        ModelFile(denoise.model_path().name, 3458497,
                  "987073f5e4f43365456da5121b1786d750bb4d39bfed6360b7e36ff4a30069de"),
    ],
}

# Disponibilité réelle (onnxruntime importable + modèle chargeable) : même source que
# /automask/available, pour ne jamais afficher « installé » sur un modèle illisible.
AVAILABLE = {
    "subject": segment.available,
    "point": segment.point_available,
    "denoise": denoise.available,
}

# feature -> {downloading: bool, received: int, total: int|None, error: str|None}
_progress: dict[str, dict] = {}
_lock = threading.Lock()


def _download_feature(feature: str, files: list[ModelFile]) -> None:
    received = 0
    try:
        config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        for f in files:
            url = _url(f.name)
            dest = config.MODELS_DIR / f.name
            part = dest.with_name(dest.name + ".part")
            digest = hashlib.sha256()
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT) as r, \
                    open(part, "wb") as out:  # noqa: S310 (https only)
                while chunk := r.read(262144):
                    out.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                    with _lock:
                        _progress[feature]["received"] = received
            actual = part.stat().st_size
            if f.size and actual != f.size:
                part.unlink(missing_ok=True)
                raise RuntimeError(f"Taille inattendue pour {f.name} ({actual} ≠ {f.size})")
            if f.sha256 and digest.hexdigest() != f.sha256:
                part.unlink(missing_ok=True)
                raise RuntimeError(f"Empreinte SHA-256 invalide pour {f.name} "
                                   "(fichier altéré ou source modifiée)")
            part.replace(dest)  # rename atomique : jamais de fichier à moitié écrit (ni non vérifié) visible
        with _lock:
            _progress[feature]["downloading"] = False
    except Exception as e:  # noqa: BLE001 — on remonte l'erreur au client via le statut
        log.exception("Téléchargement du modèle '%s' échoué", feature)
        with _lock:
            _progress[feature].update(downloading=False, error=str(e))


@router.get("/models/status")
def status():
    """État de chaque feature IA : présence des fichiers, config, et progression en cours."""
    out = {}
    for feat, files in FEATURES.items():
        p = _progress.get(feat, {})
        out[feat] = {
            "available": AVAILABLE[feat](),
            "configured": bool(MODELS_BASE_URL),
            "size": sum(f.size for f in files),
            "downloading": p.get("downloading", False),
            "received": p.get("received", 0),
            "total": p.get("total"),
            "error": p.get("error"),
        }
    return out


class DownloadBody(BaseModel):
    feature: str
    force: bool = False  # relance même si un précédent téléchargement est marqué « en cours » (bloqué)


@router.post("/models/download")
def download(body: DownloadBody):
    files = FEATURES.get(body.feature)
    if not files:
        raise HTTPException(404, "Feature inconnue")
    if not MODELS_BASE_URL:
        raise HTTPException(400, "URL de base des modèles non configurée")
    with _lock:
        if _progress.get(body.feature, {}).get("downloading") and not body.force:
            raise HTTPException(409, "Téléchargement déjà en cours")
        _progress[body.feature] = {"downloading": True, "received": 0,
                                   "total": sum(f.size for f in files) or None, "error": None}
    threading.Thread(target=_download_feature, args=(body.feature, files), daemon=True).start()
    return {"started": True}

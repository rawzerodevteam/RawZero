"""Téléchargement à la demande des modèles IA (segmentation du sujet, clic EdgeSAM, débruitage).

Les modèles ONNX ne sont pas embarqués dans l'app (installeur léger) : l'utilisateur les
télécharge depuis l'interface, ils atterrissent dans MODELS_DIR. Le reste de l'app fonctionne
sans eux (les features concernées sont juste indisponibles, cf. segment.py / denoise.py).

Manifest = source unique de vérité. Ajouter une feature ou un fichier = éditer FEATURES.
Les URLs vides → feature "non configurée" : visible dans l'UI mais non téléchargeable tant
qu'une source de confiance n'a pas été renseignée.
"""
import logging
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
    url: str
    size: int  # octets attendus ; 0 = taille inconnue (pas de vérif)


# ponytail: manifest en dur (3 features). À déplacer en JSON externe seulement si l'utilisateur
# doit pouvoir ajouter des modèles sans rebuild.
# Les noms de fichiers viennent de segment.py / denoise.py (source unique) : renommer un modèle
# là-bas suffit, le téléchargement et la dispo suivent automatiquement.
FEATURES: dict[str, list[ModelFile]] = {
    "subject": [
        ModelFile(segment.model_path().name,
                  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
                  4574861),
    ],
    # EdgeSAM : poids officiels (Space HuggingFace chongzhou/EdgeSAM). Tailles inconnues → pas de vérif.
    "point": [
        ModelFile(segment.sam_encoder_path().name,
                  "https://huggingface.co/spaces/chongzhou/EdgeSAM/resolve/main/weights/edge_sam_3x_encoder.onnx",
                  0),
        ModelFile(segment.sam_decoder_path().name,
                  "https://huggingface.co/spaces/chongzhou/EdgeSAM/resolve/main/weights/edge_sam_3x_decoder.onnx",
                  0),
    ],
    # FFDNet : pas d'URL ONNX publique fiable pour ce fichier → dépôt manuel dans data/models/.
    "denoise": [
        ModelFile(denoise.model_path().name, "", 0),
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
            if not f.url:
                raise RuntimeError(f"URL non configurée pour {f.name}")
            dest = config.MODELS_DIR / f.name
            part = dest.with_name(dest.name + ".part")
            with urllib.request.urlopen(f.url) as r, open(part, "wb") as out:  # noqa: S310 (https only)
                while chunk := r.read(262144):
                    out.write(chunk)
                    received += len(chunk)
                    with _lock:
                        _progress[feature]["received"] = received
            if f.size and part.stat().st_size != f.size:
                part.unlink(missing_ok=True)
                raise RuntimeError(f"Taille inattendue pour {f.name} "
                                   f"({part.stat().st_size} ≠ {f.size})")
            part.replace(dest)  # rename atomique : jamais de fichier à moitié écrit visible
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
            "configured": all(f.url for f in files),
            "size": sum(f.size for f in files),
            "downloading": p.get("downloading", False),
            "received": p.get("received", 0),
            "total": p.get("total"),
            "error": p.get("error"),
        }
    return out


class DownloadBody(BaseModel):
    feature: str


@router.post("/models/download")
def download(body: DownloadBody):
    files = FEATURES.get(body.feature)
    if not files:
        raise HTTPException(404, "Feature inconnue")
    if not all(f.url for f in files):
        raise HTTPException(400, "URL(s) non configurée(s) pour cette feature")
    with _lock:
        if _progress.get(body.feature, {}).get("downloading"):
            raise HTTPException(409, "Téléchargement déjà en cours")
        _progress[body.feature] = {"downloading": True, "received": 0,
                                   "total": sum(f.size for f in files) or None, "error": None}
    threading.Thread(target=_download_feature, args=(body.feature, files), daemon=True).start()
    return {"started": True}

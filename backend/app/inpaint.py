"""Correcteur de taches par IA (inpainting) via ONNX Runtime (CPU).

Moteur : MI-GAN, pipeline ONNX officiel (`andraniksargsyan/migan` sur Hugging Face,
`Picsart-AI-Research/MI-GAN` — ICCV 2023), `data/models/migan.onnx`. Mêmes conventions que
`segment.py`/`denoise.py` : chargement paresseux, dégradation propre (si `onnxruntime` ou le
modèle est absent, `available()` renvoie False et `inpaint()` lève une `InpaintUnavailable`, le
reste de l'app continue de tourner).

Signature du graphe (introspectée depuis le modèle officiel, `scripts/create_onnx_pipeline.py`
du dépôt MI-GAN) : `image` uint8 (1,3,H,W) et `mask` uint8 (1,1,H,W), résolution **dynamique**
(pas de redimensionnement à une taille fixe côté appelant — le pipeline recadre et ajoute son
propre contexte en interne, `padding=128` autour de la zone masquée, avant de recomposer le
résultat dans l'image d'entrée). Convention du masque : 255 = connu (à garder), 0 = trou (à
remplir) — l'inverse de la convention RawZero (`build_mask` : 1 = zone à corriger). Le graphe
accepte nominalement des valeurs de masque intermédiaires (fondu documenté comme géré en interne,
`F.max_pool2d` + flou gaussien) mais **constaté empiriquement inutilisable en pratique** : un bord
adouci (feather) fait sortir un artefact blanc délavé sur toute la zone remplie. L'appelant
(`routers/edits.py::inpaint_spot`) binarise donc le masque (seuil 0.5) avant de le passer ici — le
fondu du bord reste appliqué séparément, au moment du compositing (`pipeline._apply_inpaint`).
`_detect_layout` reste une introspection générique (comme `denoise._detect_layout`) plutôt qu'un
nom en dur, au cas où une variante d'export circulerait avec des noms d'entrée différents.
"""
import logging
import threading
from typing import Optional

import numpy as np

from . import config

log = logging.getLogger(__name__)

_session = None
_layout: Optional[dict] = None   # {"img": name, "mask": name}
_lock = threading.Lock()
_load_failed = False


class InpaintUnavailable(RuntimeError):
    """Levée quand le moteur ou le modèle d'inpainting n'est pas disponible."""


def model_path():
    return config.MODELS_DIR / "migan.onnx"


def available() -> bool:
    """True si l'inférence est possible (onnxruntime importable + fichier modèle présent)."""
    if _load_failed:
        return False
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return model_path().exists()


def _detect_layout(sess) -> dict:
    """Identifie l'entrée image (3 canaux) et masque (1 canal) par leur forme déclarée, plutôt
    que de figer les noms `"image"`/`"mask"` du modèle officiel (robuste à une variante d'export)."""
    inputs = sess.get_inputs()

    def ch(inp):
        s = inp.shape
        return s[1] if len(s) == 4 and isinstance(s[1], int) else None

    img = next((i.name for i in inputs if ch(i) == 3), inputs[0].name)
    mask_inp = next((i for i in inputs if ch(i) == 1 and i.name != img), None)
    return {"img": img, "mask": mask_inp.name if mask_inp else None}


def _get_session():
    global _session, _layout, _load_failed
    if _session is not None:
        return _session, _layout
    with _lock:
        if _session is not None:
            return _session, _layout
        try:
            import onnxruntime as ort
        except Exception as e:
            _load_failed = True
            raise InpaintUnavailable("onnxruntime n'est pas installé") from e
        path = model_path()
        if not path.exists():
            raise InpaintUnavailable(f"Modèle introuvable : {path}")
        try:
            so = ort.SessionOptions()
            so.intra_op_num_threads = 0  # auto
            sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        except Exception as e:
            _load_failed = True
            raise InpaintUnavailable(f"Chargement du modèle impossible : {e}") from e
        _session = sess
        _layout = _detect_layout(sess)
        log.info("Modèle d'inpainting chargé : %s (%s)", path.name, _layout)
    return _session, _layout


def inpaint(img: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """`img` : float32 RGB 0..1, résolution de travail (pas besoin de recadrage préalable — le
    pipeline MI-GAN gère son propre contexte en interne). `mask` : float32 (h, w) 0..1, 1 = zone
    à remplir. Renvoie float32 RGB 0..1, **mêmes dimensions que `img`** ; seule la zone masquée
    (+ contexte immédiat) diffère de l'entrée, le reste est recopié à l'identique par le graphe."""
    sess, layout = _get_session()
    img_u8 = (np.clip(img, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    # 255 = connu, 0 = trou (inverse de notre convention) — cf. docstring du module.
    known_u8 = ((1.0 - np.clip(mask, 0.0, 1.0)) * 255.0 + 0.5).astype(np.uint8)
    xin = np.transpose(img_u8, (2, 0, 1))[None]                 # 1,3,H,W
    feeds = {layout["img"]: xin}
    if layout["mask"] is not None:
        feeds[layout["mask"]] = known_u8[None, None]            # 1,1,H,W
    out = np.asarray(sess.run(None, feeds)[0])[0]                # 3,H,W uint8
    out = np.transpose(out, (1, 2, 0))
    return out.astype(np.float32) / 255.0

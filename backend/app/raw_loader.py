"""Décodage RAW (rawpy/LibRaw) et images classiques + extraction EXIF / thumb embarqué."""
import io
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image, ImageOps

from . import config

log = logging.getLogger(__name__)
Image.MAX_IMAGE_PIXELS = None  # les RAW haute résolution dépassent la limite par défaut


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in config.RAW_EXTS


def decode_full(path: Path) -> np.ndarray:
    """Décode en float32 RGB 0..1 (sRGB), pleine résolution."""
    if is_raw(path):
        import rawpy
        with rawpy.imread(str(path)) as raw:
            rgb16 = raw.postprocess(
                use_camera_wb=True,
                no_auto_bright=True,
                output_bps=16,
                output_color=rawpy.ColorSpace.sRGB,
            )
        return rgb16.astype(np.float32) / 65535.0
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("I;16", "I"):
        arr = np.asarray(img, dtype=np.float32) / 65535.0
        return np.stack([arr] * 3, axis=-1)
    img = img.convert("RGB")
    return np.asarray(img, dtype=np.float32) / 255.0


def extract_embedded_jpeg(path: Path) -> Optional[Image.Image]:
    """JPEG embarqué d'un RAW (rapide, pour le mode tri). None si indisponible."""
    if not is_raw(path):
        return None
    try:
        import rawpy
        with rawpy.imread(str(path)) as raw:
            try:
                thumb = raw.extract_thumb()
            except Exception:
                return None
            if thumb.format == rawpy.ThumbFormat.JPEG:
                img = Image.open(io.BytesIO(thumb.data))
                img.load()
            else:  # bitmap
                img = Image.fromarray(thumb.data)
        return _apply_exif_orientation(img, path)
    except Exception as e:  # fichier corrompu, format exotique…
        log.warning("Thumb embarqué illisible pour %s : %s", path.name, e)
        return None


def _apply_exif_orientation(img: Image.Image, path: Path) -> Image.Image:
    ori = read_exif(path).get("_orientation", 1)
    method = {3: Image.ROTATE_180, 6: Image.ROTATE_270, 8: Image.ROTATE_90}.get(ori)
    return img.transpose(method) if method else img


def _ratio(v: Any) -> float:
    try:
        return float(v.num) / float(v.den) if v.den else 0.0
    except AttributeError:
        return float(v)


def read_exif(path: Path) -> dict[str, Any]:
    """Métadonnées utiles (best effort : CR3/HEIF non TIFF-based peuvent échouer)."""
    meta: dict[str, Any] = {
        "captured_at": "", "camera": "", "lens": "", "iso": 0,
        "aperture": 0.0, "shutter": "", "focal": 0.0, "_orientation": 1,
    }
    try:
        import exifread
        with open(path, "rb") as f:
            tags = exifread.process_file(f, details=False)

        def s(*names: str) -> str:
            for n in names:
                if n in tags:
                    return str(tags[n]).strip()
            return ""

        dt = s("EXIF DateTimeOriginal", "Image DateTime")
        if dt:
            try:
                meta["captured_at"] = datetime.strptime(dt, "%Y:%m:%d %H:%M:%S").isoformat()
            except ValueError:
                pass
        make, model = s("Image Make"), s("Image Model")
        meta["camera"] = model if make and model.startswith(make) else f"{make} {model}".strip()
        meta["lens"] = s("EXIF LensModel", "MakerNote LensType")
        try:
            meta["iso"] = int(s("EXIF ISOSpeedRatings") or 0)
        except ValueError:
            pass
        if "EXIF FNumber" in tags:
            meta["aperture"] = round(_ratio(tags["EXIF FNumber"].values[0]), 1)
        meta["shutter"] = s("EXIF ExposureTime")
        if "EXIF FocalLength" in tags:
            meta["focal"] = round(_ratio(tags["EXIF FocalLength"].values[0]), 1)
        if "Image Orientation" in tags:
            vals = tags["Image Orientation"].values
            if vals:
                meta["_orientation"] = int(vals[0])
    except Exception as e:
        log.debug("EXIF illisible pour %s : %s", path.name, e)
    if not meta["captured_at"]:
        meta["captured_at"] = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    return meta


def image_dimensions(path: Path) -> tuple[int, int]:
    """(width, height) sans décoder toute l'image quand c'est possible."""
    if is_raw(path):
        try:
            import rawpy
            with rawpy.imread(str(path)) as raw:
                sizes = raw.sizes
                w, h = sizes.width, sizes.height
                if sizes.flip in (5, 6):  # rotation 90° appliquée au postprocess
                    w, h = h, w
                return w, h
        except Exception:
            return 0, 0
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            return img.width, img.height
    except Exception:
        return 0, 0

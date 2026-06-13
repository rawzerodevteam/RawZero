# Étude : Architecture des éditeurs photo modernes & optimisations pour les masques

**Date** : Juin 2026  
**Sujet** : Analyse comparative des architectures d'édition photo (Lightroom, Darktable, Capture One, Affinity Photo, RawTherapee) avec focus sur les masques locaux.

---

## Table des matières

1. [Vue d'ensemble](#vue-densemble)
2. [Les cinq architectures comparées](#les-cinq-architectures-comparées)
3. [Composants critiques](#composants-critiques)
4. [Analyse détaillée des masques](#analyse-détaillée-des-masques)
5. [Stockage et portabilité des édits](#stockage-et-portabilité-des-édits)
6. [Pipeline de traitement](#pipeline-de-traitement)
7. [Problèmes identifiés dans RawStudio](#problèmes-identifiés-dans-rawstudio)
8. [Recommandations architecturales](#recommandations-architecturales)

---

## Vue d'ensemble

Les éditeurs photo modernes partagent une structure commune mais divergent sur :
- **Système de masques** : raster vs. vecteur vs. paramétriques vs. AI-based
- **Pipeline d'opérations** : ordre figé vs. flexible, avec/sans branchement
- **Stockage des édits** : JSON vs. XMP vs. format propriétaire
- **Rendering** : immediate vs. lazy vs. cached layers
- **GPU** : CPU-only vs. optional GPU (OpenCL/CUDA)

Le **point critique identifié** : les masques sont souvent une "couche de plombage" mal intégrée au reste du pipeline, causant des problèmes de performance et de maintenabilité.

---

## Les cinq architectures comparées

### 1. Adobe Lightroom (et Lightroom Classic)

**Positionnement** : Logiciel dominant, desktop + cloud, ~15 millions d'utilisateurs.

**Architecture générale** :
- **Backend** : C++ (moteur de rendu), SQLite local (catalogue), écosystème cloud (Creative Cloud).
- **Frontend** : Native (macOS/Windows) + web.
- **Non-destructif** : XML embedded dans le catalogue SQLite ou XMP sidecars.

**Système de masques** :
- **Types** : Brush mask, radial/linear gradient masks, range masks (luminance/color), AI-based object detection (ciel, peau, etc.)
- **Architecture** : 
  - Masques stockés comme splines/polylignes (vecteur) + metadata (feather, opacity).
  - Au rendu : rasterisation runtime en float32.
  - Blending : masque × adjustment, puis compositing dans le pipeline.
  - **AI masks** : détection scene-aware (Sky, Skin, Foliage, Vegetation, etc.) — cachée par Adobe, probablement basée sur ML tiers (segment-anything-like).

**Pipeline** :
1. Import RAW → extract embedded JPEG thumbnail.
2. Develop view : affiche preview flat (pas de masques visibles pendant le rendu interactif).
3. Render on demand : applique tous les edits + masques dans l'ordre.
4. Export : full-res RAW decode + pipeline complet.

**Forces** :
- Masques ultra-polishés (UX proche de Photoshop).
- Range masks combinables (intersection, union).
- Intégration cloud native.
- AI detection sans paramètres utilisateur.

**Faiblesses** :
- Magicblack pour le traitement exact des masques (probablement ordre d'opération secret).
- Pas de vrai contrôle sur les masques au niveau du code.
- Vendor lock-in complet (édits non portables sans propriétaire).

---

### 2. Darktable (open-source)

**Positionnement** : Alternative libre, ~50k utilisateurs actifs, focus sur fonctionnalités avancées.

**Architecture générale** :
- **Backend** : C (legacy) + C++ (refactor en cours), pipeline modulaire.
- **Database** : SQLite + XMP sidecars (double stockage).
- **Frontend** : GTK4 (Linux/macOS), Windows via WSL2.

**Système de masques** :
- **Types** : 
  - Drawn masks : paths/polylignes (vecteur), convertis en raster pour le blending.
  - Parametric masks : selection par luminance, couleur, taille d'objet, position.
  - Shapes : rectangles, ellipses, paths avec feathering.
  - **Object masks (nouveau, 4.0+)** : AI segment-anything, non-déterministe → cachée dans la DB.

- **Architecture** :
  - Stockage interne : `dt_masks_form_t` (points vecteurs) + metadata.
  - Rendering : chaque masque rasterisé indépendamment → blending avec opérateurs booléens (add/subtract/intersect).
  - Ordre : shapes empilées top-to-bottom, masques applicables sur n'importe quel module du pipeline.

- **Chaîne complète** :
  ```
  Vector shapes (DB) → Rasterize runtime → Boolean operations → Float32 mask
  → Blend with module output
  ```

**Forces** :
- Vrai separation of concerns : masques = objet indépendant, réutilisable.
- Parametric masks = pas de rasterisation prématurée.
- XMP sidecars = portabilité.
- Open-source = lisibilité totale.

**Faiblesses** :
- Object masks via AI non-déterministe → casse la reproducibilité (note dans les issues GitHub).
- UI datée (GTK), moins fluide que Lightroom.
- Performance : pas d'accélération GPU native (expérimental seulement).

---

### 3. Capture One (propriétaire, haut de gamme)

**Positionnement** : Édition professionnelle (studio, fashion, e-commerce), ~5% de marché, très performant.

**Architecture générale** :
- **Backend** : C++ (propriétaire), pipeline optimisé pour ICC profiles.
- **Database** : Embedded, édits en JSON.
- **Non-destructif** : édits en sidecar + catalogue interne.

**Système de masques** :
- **Types** : Brush, linear/radial, range (luminance/color, gamme précise).
- **Architecture** :
  - Masques = adjustments appliqués dans l'ordre du pipeline.
  - Chaque adjustment (ex: exposure, curves) a un masque attaché.
  - **Clé** : le pipeline est **ordonné et figé**, pas de branchement.
  - Rasterisation au rendu, float32.

**Pipeline (figé)** :
```
Input → Levels → Curves → (next color tool) → ...
Masques appliqués en parallèle par adjustment.
```

**Forces** :
- Hyper-performance : GPU OpenCL optional, mais CPU optimisé (37x speedup pour certains traitements).
- Pipeline clair et prévisible.
- Color management ICC = fidélité impression.
- Sidecar portables = édits reloadables ailleurs.

**Faiblesses** :
- Pipeline figé = pas de flexibilité (ex: courbe avant exposition est impossible).
- Masques attachés aux adjustments = pas de réutilisation.
- Propriétaire = pas de visibilité architecture.

---

### 4. Affinity Photo (semi-destructive, hybride)

**Positionnement** : Alternative Photoshop pour design/photo, cross-platform (iOS, macOS, Windows).

**Architecture générale** :
- **Backend** : C++ (moteur pixel), Metal/GPU native.
- **Non-destructif** : Smart Objects + Adjustment Layers + Layer Masks.
- **Database** : None (document = fichier .afphoto, ZIP interne).

**Système de masques** :
- **Types** :
  - **Layer masks** : grayscale raster, pixel-based blending.
  - **Clipping masks** : vecteur basé shapes.
  - **Live masks** (nouveau) : parametric, update auto sur changement image (luminance range, hue range, etc.).
  - **Compound masks** : combinaison booléenne de masques (add/intersect/subtract/XOR).

- **Architecture** :
  ```
  Layer structure:
  ├─ Base layer (pixels)
  ├─ Adjustment layer 1 + layer mask
  ├─ Adjustment layer 2 + layer mask
  └─ ...
  
  Rendering: bottom-to-top, mask × adjustment blend, composite result.
  ```

- **Live Masks** (clé innovation 2022+) :
  - Paramétriques, MAJ auto.
  - Stored as JSON (hue/lum range + params), pas de raster hardcodé.
  - Rasterisées at render-time.

**Forces** :
- Hybrid model = flexibility (raster + vector).
- Compound masks = expressivité haute.
- Layer-based = separation clear (diff de Darktable qui est module-based).
- Live masks = future-proof (editable metadata, no rasterization lock-in).

**Faiblesses** :
- Nécessite structure de layers = plus lourd que RawStudio (RAW edit, not composite).
- Smart Objects = overhead (sub-documents).
- Propriétaire (quasi Photoshop-like, moins open que Darktable).

---

### 5. RawTherapee (open-source, fork ART)

**Positionnement** : Alternative libre, ~30k utilisateurs, RAW-focused comme Darktable.

**Architecture générale** :
- **Backend** : C++ (rtengine), separation complete UI/engine.
- **Database** : Embedded, edits JSON ou sidecar.
- **Non-destructif** : sidecar XML.

**Système de masques** :
- **Types** :
  - "Graduated filter" (masque dégradé linéaire/radial).
  - "Spot removal" (rectangle/ellipse, cf. "RT-spots").
  - **Local Adjustments** : masques paramétriques (luminance, color range selection).
  - Pas de AI masks natifs.

- **Architecture** :
  - Masques = metadata + apply per-module.
  - No vector storage = shapes définies par paramètres (center, angle, feather).
  - Rasterisation at pipeline execution.
  - **Numbering system** : chaque tool numéroté (Log Encoding = 0, ..., Color & Light = 11), masques suivent l'ordre.

**Pipeline** :
```
Tool 0 (Log Encoding) → Tool 1 → ... → Tool 11 (Color & Light)
Each tool can have masks applied.
```

**Forces** :
- Moteur/UI séparation = réutilisable (cf. ART fork).
- Sidecar standards = portabilité.
- Approche procedural (params) pas raster-locked.

**Faiblesses** :
- Pas d'AI masks.
- UI basée ART moins moderne que Darktable GTK4.
- Local adjustments = "bolted-on" (pas intégré au pipeline de la même façon que Capture One).

---

## Composants critiques

### 1. Décodage RAW et caching

| Logiciel | Décodage | Cache preview | Cache base dev | Perf |
|---|---|---|---|---|
| Lightroom | LibRaw/propriétaire | JPEG DCRAW | Smart preview (2560px) | ⭐⭐⭐⭐⭐ |
| Darktable | LibRaw | Mipmap pyramid (2048→512→...) | None (decode on-fly) | ⭐⭐⭐ |
| Capture One | Propriétaire | JPEG fast | Cached (float16 base) | ⭐⭐⭐⭐⭐ |
| Affinity Photo | Hardware (Metal) | Layer rasters | Smart Object sub-doc | ⭐⭐⭐⭐ |
| RawTherapee | LibRaw | Cache flat | None | ⭐⭐⭐ |

**Observation clé** : Lightroom et Capture One cachent une **base de développement** (2560-3000px, float16) → rejouer le pipeline sur cette base à chaque slider move (100-300 ms). RawStudio le fait aussi via `.npy` cache.

### 2. Rasterisation des masques

| Logiciel | Approche | Moment | Format |
|---|---|---|---|
| Lightroom | Raster (GPU?) | Runtime | Float32 texture |
| Darktable | Raster | Runtime per-module | Float32 |
| Capture One | Raster | Runtime | Float32 |
| Affinity Photo | Raster (Metal) | Runtime | Native GPU texture |
| RawTherapee | Shape params → raster | Runtime | NumPy array |

**Observation** : Tous rasterisent à runtime (pas de pré-rasterisation). Raison : transformation géométrique (crop/rotate) doit passer avant le masque.

### 3. Blending des masques

**Lightroom / Darktable / Capture One** : 
```
output = base × (1 - mask) + adjustment × mask
```

**Affinity Photo** :
```
output = base.blend(adjustment, mask, blendMode)
```
(supporte multiple blend modes : multiply, screen, overlay, etc.)

**RawTherapee** : 
```
Appliqué par module (ex: exposure adjustment × mask).
```

---

## Analyse détaillée des masques

### Problèmes architecturaux identifiés

#### 1. Masques ≠ premières classes dans le design

**Darktable** : Masques comme objets indépendants, rédaction à DB. **Bon**.  
**Lightroom/Capture One** : Masques attachés aux adjustments. **Moyen** — difficulté à réutiliser un masque sur plusieurs outils.  
**RawStudio (actuellement)** : Masques = métadata `{id, type, points, feather}` dans edits. **Minimal** — pas de vrai système.

**Recommandation** : 
```
Modèle Darktable + amélioration Affinity.

struct Mask {
  id: string (uuid)
  type: 'brush' | 'linear' | 'radial' | 'parametric'
  
  // Vector (pour brush/linear/radial)
  points?: {x, y, pressure?}[]
  
  // Parametric (luminance/color range)
  parametric?: {mode, min, max, feather, invert}
  
  // Metadata
  feather: float
  opacity: float
  inverted: bool
  
  // Runtime cache
  rasterized?: Float32Array  // caching après rasterisation
}

// Indépendant d'adjustment, mappable 1-to-many.
```

#### 2. Ordre d'application des masques

**Lightroom / Darktable** : Masques = adjustment-level, ordre = order of tools.  
**Capture One** : Pipeline figé, masques appliqués par adjustment.  
**RawStudio** : Masques appliqués in-pipeline (correct), mais pas de gestion d'ordre de masques.

**Problème** : Si 2 masques sur même tool, pas clair comment ils se combinent (AND? OR?).

**Recommandation** :
```python
# masks.py, refactor

class LocalAdjustmentMask:
    def __init__(self, mask_id: str, blend_mode: str = 'normal'):
        self.mask_id = mask_id  # ref à Mask
        self.blend_mode = blend_mode  # 'normal', 'add', 'multiply', etc.

# Dans edits:
edits = {
    'masks': {
        'mask_1': {type: 'brush', points: [...]},
        'mask_2': {type: 'linear', ...},
    },
    'adjustments': [
        {
            'tool': 'exposure',
            'value': 0.5,
            'masks': [
                {'mask_id': 'mask_1', 'mode': 'normal'},
                {'mask_id': 'mask_2', 'mode': 'add'},
            ]
        }
    ]
}
```

#### 3. Performance de rasterisation

**Darktable** : Rasterise chaque masque indépendamment, puis combine.  
**Lightroom** : Probablement GPU-accéléré (pas documenté).  
**RawStudio (actuellement)** : NumPy rasterisation → CPU-bound.

**Problème** : Avec 5+ masques, rasterisation peut devenir goulot.

**Mesure** :
```python
# À implémenter dans tests/test_performance.py
def test_mask_rasterization_speed():
    for n_masks in [1, 5, 10]:
        masks = [random_brush_mask() for _ in range(n_masks)]
        t0 = time.perf_counter()
        for _ in range(100):
            for mask in masks:
                rasterize_mask(mask, width=2560, height=1920)
        elapsed = time.perf_counter() - t0
        print(f"{n_masks} masks: {elapsed/100*1000:.2f} ms/iteration")
```

**Recommandation** : 
- Cache rasterisé intra-session (LRU).
- GPU compute (CUDA/OpenCL) optional pour heavy lifting.

---

## Stockage et portabilité des édits

### Formats standards

**XMP Sidecar** (Adobe/Darktable/RawTherapee) :
```xml
<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta ...>
  <rdf:RDF ...>
    <rdf:Description ...>
      <!-- Edits -->
      <crs:Exposure>0.5</crs:Exposure>
      <crs:Contrast>10</crs:Contrast>
      <!-- Masques -->
      <crs:InternalMask>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Mask01" .../>
          </rdf:li>
        </rdf:Seq>
      </crs:InternalMask>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
```

**Avantages** :
- Texte (human-readable).
- Standard ISO (Lightroom, Darktable, RawTherapee le lisent).
- Portable (sidecar = petit fichier séparé).

**Désavantages** :
- Verbeux.
- Pas toutes les features supportées universellement.

### Approche RawStudio

**Actuellement** : Edits JSON dans SQLite, pas de XMP export.

**Recommandation** :
```python
# backend/app/xmp_export.py

def edits_to_xmp(photo_id: str, edits: dict) -> str:
    """
    Serialize RawStudio edits to XMP sidecar.
    Omit features not in XMP standard (e.g., local masks → crs:InternalMask).
    """
    # Global adjustments → standard XMP properties
    # Local masks → crs:InternalMask or proprietary extension
    # ...
    return xmp_xml_string

# Option: Export XMP on edit save (async background task)
# Benefit: Edits portable to Lightroom, Darktable.
```

---

## Pipeline de traitement

### Comparaison ordre d'opérations

**Lightroom** (inferred, not documented):
```
1. Lens correction (distortion, vignetting)
2. White balance & exposure (linear)
3. Tone curve
4. Saturation / Vibrance / HSL
5. Clarity / Texture
6. Detail & noise reduction
7. Grain
8. Post-crop vignetting
```

**Darktable** (module-based, flexible):
```
Input → [Demosaic] → [Exposure] → [Color in] → ...
         (can reorder in UI)
         → [Color out] → [Gamma] → Output
```

**Capture One** (figé):
```
Input → Levels → Curves → Color Range → ... (not reorderable)
```

**RawStudio (actuellement)** :
```
1. Crop
2. Rotation
3. White balance (linear)
4. Exposure (EV)
5. Tone curve (spline PCHIP)
6. HSL (8 bands)
7. Clarity / Dehaze
8. [Local masks applied per-step]
9. Noise reduction
10. Sharpening
11. Vignetting
```

**Observation** : RawStudio suit Lightroom. Capture One (figé) = plus prévisible pour l'utilisateur. Darktable (flexible) = plus puissant mais UX complexe.

### Problème identifié : Local masks appliqués "out-of-band"

**Actuellement dans `pipeline.py`** :
```python
def apply_processing(image, edits, scale=1.0):
    image = geometric_pipeline(image, edits)
    image = linear_adjustments(image, edits)  # WB, exposure
    image = tonal_adjustments(image, edits)   # Curves
    # ... etc ...
    
    # Local masks applied per-step? Or globally after?
    # Currently: "bolted-on" after main pipeline.
    image = apply_local_masks(image, edits)
    
    return image
```

**Problème** : Masques appliqués in-band vs. out-of-band = ambiguous.  
**Darktable** : Masques in-band (par module).  
**Recommandation** : Clarifier, puis refactor.

---

## Problèmes identifiés dans RawStudio

### 1. Architecture des masques "ad-hoc"

- Masques = métadata dans `edits.json`, pas d'objet indépendant.
- Pas de réutilisation inter-adjustments.
- Pas de blending modes (juste opacity).
- Rasterisation: seulement en `render.py` (pas de cache).

### 2. Pipeline non-modulaire

- Chaque ajustement = fonction indépendante (`apply_exposure`, `apply_curves`, etc.).
- Difficile d'insérer des adjustments custom ou d'en changer l'ordre.
- Local masks appliqués "après" pipeline complet (out-of-band).

### 3. Pas d'XMP export

- Édits enfermés dans SQLite.
- Non-portable à Lightroom, Darktable, Capture One.

### 4. Manque de GPU acceleration

- Pipeline NumPy/OpenCV CPU-only.
- Pour full-res export ou preview heavy, peut devenir lent (>500 ms per frame).

### 5. Rasterisation des masques non-optimisée

- Rasterisation naïve (boucle par pixel).
- Pas de cache intra-session (decode + rasterise à chaque slider move).

---

## Recommandations architecturales

### Phase 1 : Refactor masques (court terme, 2-3 semaines)

**Objectif** : Masques deviennent première classe.

```python
# backend/app/types.py
from dataclasses import dataclass
from typing import Literal

@dataclass
class Mask:
    id: str
    type: Literal['brush', 'linear', 'radial', 'parametric']
    name: str = "Unnamed mask"
    
    # Geometry
    points: list[dict]  # [{x, y, pressure?}, ...]
    feather: float = 20
    opacity: float = 1.0
    inverted: bool = False
    
    # Parametric (for 'parametric' type)
    parametric: dict | None = None  # {mode: 'luminance'|'color', min, max, ...}
    
    # Runtime cache
    _rasterized: np.ndarray | None = None

# backend/app/pipeline.py
class Pipeline:
    def __init__(self, image: np.ndarray, edits: dict, masks: dict[str, Mask]):
        self.image = image
        self.edits = edits
        self.masks = {mid: self._prepare_mask(m) for mid, m in masks.items()}
    
    def _prepare_mask(self, mask: Mask) -> np.ndarray:
        """Rasterize + cache."""
        if mask._rasterized is None:
            mask._rasterized = rasterize_mask(mask, self.image.shape)
        return mask._rasterized
    
    def apply_adjustment(self, tool_name: str, params: dict):
        """Apply tool with optional masks."""
        mask_ids = params.get('masks', [])
        combined_mask = self._combine_masks(mask_ids)
        
        # Apply adjustment
        adjusted = self._tool_apply(tool_name, params)
        
        # Blend with mask
        output = self.image * (1 - combined_mask) + adjusted * combined_mask
        self.image = output
    
    def _combine_masks(self, mask_ids: list[str]) -> np.ndarray:
        """Combine multiple masks (AND, OR, etc.)."""
        masks = [self.masks[mid] for mid in mask_ids]
        combined = np.ones_like(self.image[:,:,0])
        for mask in masks:
            combined *= mask  # AND operation
        return combined

# backend/app/edits.py
edits_schema = {
    'masks': {
        'mask_1': {
            'type': 'brush',
            'points': [{x, y, pressure}, ...],
            'feather': 20,
            'opacity': 1.0,
        },
        'mask_2': {
            'type': 'parametric',
            'parametric': {'mode': 'luminance', 'min': 0, 'max': 128},
        }
    },
    'adjustments': [
        {
            'tool': 'exposure',
            'value': 0.5,
            'mask_ids': ['mask_1']  # Ref to masks
        },
        {
            'tool': 'curves',
            'points': [...],
            'mask_ids': ['mask_2']
        }
    ]
}
```

**Fichiers à modifier** :
- `backend/app/types.py` : Ajouter `Mask` dataclass.
- `backend/app/pipeline.py` : Refactor pour in-band masks.
- `backend/app/routers/edits.py` : PUT /api/photos/{id}/edits inclure masks.
- `frontend/src/types.ts` : Ajouter `Mask` TypeScript type.
- `frontend/src/components/MaskEditor.tsx` : UI éditeur masques (nouveau).

---

### Phase 2 : XMP export (court terme, 1-2 semaines)

**Objectif** : Édits portables à Lightroom/Darktable.

```python
# backend/app/xmp.py
import xml.etree.ElementTree as ET

def edits_to_xmp(photo: Photo, edits: dict) -> str:
    """Convert RawStudio edits to XMP sidecar."""
    root = ET.Element('x:xmpmeta')
    rdf = ET.SubElement(root, 'rdf:RDF')
    desc = ET.SubElement(rdf, 'rdf:Description')
    
    # Global adjustments (standard Lightroom tags)
    desc.set('crs:Exposure2012', str(edits['exposure']))
    desc.set('crs:Contrast2012', str(edits.get('contrast', 0)))
    # ... etc
    
    # Local masks (crs:InternalMask or proprietary)
    # Omit masques complexes (feather, non-standard) to avoid breakage in other tools.
    
    return ET.tostring(root, encoding='unicode')

# backend/app/routers/export.py
@app.post('/api/export/xmp/{photo_id}')
async def export_xmp(photo_id: str):
    """Export edits as XMP sidecar."""
    photo = db.get_photo(photo_id)
    xmp_content = edits_to_xmp(photo, photo.edits)
    return {
        'filename': f"{photo.filename}.xmp",
        'content': xmp_content
    }
```

---

### Phase 3 : Modularisation pipeline (moyen terme, 4-6 semaines)

**Objectif** : Pipeline réorderable, custom adjustments.

```python
# backend/app/pipeline_v2.py
class Adjustment:
    def apply(self, image: np.ndarray, params: dict, mask: np.ndarray | None = None) -> np.ndarray:
        raise NotImplementedError

class ExposureAdjustment(Adjustment):
    def apply(self, image, params, mask=None):
        ev = params['value']
        adjusted = image * (2 ** ev)
        if mask is not None:
            adjusted = image * (1 - mask) + adjusted * mask
        return adjusted

class CurveAdjustment(Adjustment):
    def apply(self, image, params, mask=None):
        # ...

class PipelineBuilder:
    def __init__(self, image):
        self.image = image
        self.adjustments = []
    
    def add(self, adj: Adjustment, params: dict, mask_ids: list[str] | None = None):
        self.adjustments.append((adj, params, mask_ids))
        return self
    
    def render(self, masks: dict[str, Mask]) -> np.ndarray:
        result = self.image
        for adj, params, mask_ids in self.adjustments:
            combined_mask = combine_masks(masks, mask_ids) if mask_ids else None
            result = adj.apply(result, params, combined_mask)
        return result

# Usage:
pipeline = PipelineBuilder(raw_image)
pipeline.add(ExposureAdjustment(), {'value': 0.5}, ['mask_1'])
pipeline.add(CurveAdjustment(), {'points': [...]}, None)
result = pipeline.render(masks)
```

---

### Phase 4 : GPU acceleration (long terme, 2-3 mois)

**Objectif** : Full-res export < 1 sec, preview <200 ms.

```python
# backend/app/gpu_pipeline.py (optional, OpenCL backend)
import pyopencl as cl

class GPUPipeline:
    def __init__(self):
        self.ctx = cl.create_some_context()
        self.queue = cl.CommandQueue(self.ctx)
    
    def apply_exposure_gpu(self, image_gpu, ev):
        # OpenCL kernel for exposure (fast on GPU)
        ...
    
    def rasterize_mask_gpu(self, mask, width, height):
        # Rasterization via GPGPU
        ...

# Fallback to CPU if GPU unavailable (env var RAW_ENABLE_GPU=1)
```

---

## Synthèse comparative : RawStudio vs. Leaders

| Aspect | RawStudio | Lightroom | Darktable | Capture One | Affinity | RawTherapee |
|---|---|---|---|---|---|---|
| **Masques** | Ad-hoc | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Pipeline modulaire** | Non | Figé | Flexible | Figé | Layers | Figé |
| **AI masks** | Non | ⭐⭐⭐⭐⭐ | Partial | Non | Partial | Non |
| **Portabilité edits** | SQLite only | XML/Cloud | XMP | Sidecar | .afphoto | XMP |
| **GPU** | Non | Opt. | Non | OpenCL opt. | Metal | Non |
| **Open-source** | Non (privé) | Non | ✓ | Non | Non | ✓ |
| **Performance** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## Conclusion & Plan d'action

**Problème critique identifié** : RawStudio masques ≠ première classe. Architecture "ad-hoc" limite scalabilité et maintenabilité.

**Recommendation** : Adopter modèle **Darktable** (masques objets indépendants) + innovation **Affinity** (live/compound masks).

**Roadmap suggéré** :
1. **Phase 1 (juin-juillet)** : Refactor masques → objets indépendants, in-band application.
2. **Phase 2 (juillet)** : XMP export → portabilité.
3. **Phase 3 (août-septembre)** : Pipeline modulaire → reorderability.
4. **Phase 4 (Q4 2026)** : GPU acceleration (stretch goal).

**Code quality impact** : +500 LoC, +150 LoC tests, meilleure maintenabilité long-terme.

---

## Références

### Lightroom
- [Lightroom Masking Documentation](https://helpx.adobe.com/lightroom-classic/help/masking.html)
- [Lightroom 2026 Workflow Guide](https://aaapresets.com/en-hk/blogs/lightroom-workflow-step-by-step/)
- [Range Masks & Intersect](https://fstoppers.com/lightroom/intersect-masks-control-youre-missing-lightroom-721432)

### Darktable
- [Mask Manager (v4.0+)](https://docs.darktable.org/usermanual/4.0/en/module-reference/utility-modules/darkroom/mask-manager/)
- [Parametric Masks](https://docs.darktable.org/usermanual/3.8/en/darkroom/masking-and-blending/masks/parametric/)
- [Object Mask PR](https://github.com/darktable-org/darktable/pull/18331)

### Capture One
- [Processing Pipeline Overview](https://alexonraw.com/capture-one-an-overview-of-the-rendering-pipeline/)
- [OpenCL Acceleration](https://www.captureone.com/blog/processing-speedup-using-opencl-in-capture-one-pro-7)

### Affinity Photo
- [Non-Destructive Editing](https://www.dpreview.com/news/8294870350/affinity-photo-2-released-better-non-destructive-editing-new-masks-and-much-more)
- [Layer Masks & Compound Masks](https://edits101.com/masking-in-affinity-photo/)

### RawTherapee / ART
- [Local Adjustments](https://rawpedia.rawtherapee.com/Local_Adjustments)
- [Toolchain Pipeline](https://rawpedia.rawtherapee.com/Toolchain_Pipeline)

### General
- [XMP Sidecar Format](https://www.phototraces.com/lightroom-tutorials/what-is-an-xmp-file/)
- [GPU Acceleration (CUDA vs OpenCL)](https://medium.com/@sohail_saifi/gpu-accelerated-image-processing-cuda-vs-opencl-performance-comparison-77f1c3520e91)
- [Non-Destructive Photoshop Workflows](https://helpx.adobe.com/photoshop/using/nondestructive-editing.html)

---

**Auteur** : Étude comparative juin 2026  
**Statut** : Recommandations architecturales pour RawStudio v1.1+

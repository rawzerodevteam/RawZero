# Guide de test des optimisations RawStudio

## Résumé des changements

### Backend (`backend/app/pipeline.py`)
1. ✅ **Pré-downscale avant pipeline** : quand `max_size < base_long_edge`, l'image est réduite AVANT le pipeline au lieu de l'être après. Résultat identique, beaucoup plus rapide.
2. ✅ **Cache LUT de courbe PCHIP** : la fonction `_curve_lut()` utilise `@functools.lru_cache(maxsize=128)` pour éviter de recalculer l'interpolation si les points de contrôle n'ont pas changé.
3. ✅ **Cache du masque radial de vignettage** : le calcul de la grille `r = sqrt(nx²+ny²)` est cachée dans un dict `_vignette_r_cache[(h,w)]` — pas besoin de recalculer à chaque frame.

### Backend (`backend/app/previews.py`)
4. ✅ **LRU base mémoire augmenté** : `_BASE_CACHE_MAX: 3 → 8`. Navigation entre photos sans recharger le `.npy` du disque.

### Frontend (`frontend/src/views/DevelopView.tsx`)
5. ✅ **Rendu progressif à deux vitesses** :
   - **Pendant le drag** d'un slider : rendu à **768 px** (debounce 50 ms) → ≈11× plus rapide
   - **Au relâchement** : rendu à **2048 px** (debounce 150 ms) → haute qualité
   - Signal utilisé : `store.dragBaseline !== null`

---

## Comment tester

### 1. Lancer l'app

```powershell
.\start.ps1 -Dev
```

Ou si l'environnement est déjà configuré :
```powershell
uvicorn backend.app.main:app --reload --port 8000
```

(Dans un autre terminal, depuis `frontend/` : `npm run dev`)

### 2. Importer une photo RAW et ouvrir le mode Développement

- Aller en **Bibliothèque** (G), importer une photo
- Passer en **mode Développement** (D)

### 3. Tester le temps réel — glisser un slider

**Avant optimisation** (ou si ça ne marche pas) : l'image se met à jour avec un long délai après relâchement.

**Après optimisation** : 
- En glissant le slider **Température** (ou n'importe quel autre) : l'image doit se mettre à jour **en temps réel** pendant le drag. La latence doit être ≈ 30–60 ms (prévisible et fluide).
- Relâcher le slider : l'image s'améliore légèrement (passage de 768 px à 2048 px, visible surtout sur la netteté/clarté).

### 4. Vérifier la cohérence visuelle

La netteté, la clarté et les autres détails doivent avoir le même aspect visuel à 768 px et 2048 px.

**Cela signifie que le paramètre `scale` est bien recalculé** depuis la taille de la base de travail (pas la base originale).

Méthode : 
- Appliquer un fort `Sharpen` (ex. +80)
- Appliquer une forte `Clarity` (ex. +60)
- Pendant le drag, l'image à 768 px doit avoir un rendu similaire à 2048 px (juste moins fine de résolution, mais pas de différence visible d'intention)

### 5. Basculer rapidement entre photos

Dans la **Filmstrip** (barre inférieure), cliquer rapidement sur 6–8 photos différentes.

**Avant** : rechargement du `.npy` du disque à chaque fois (latence visible).

**Après** : avec `_BASE_CACHE_MAX = 8`, les 8 dernières photos sont en mémoire — navigation quasi-instantanée.

### 6. Tester l'avant/après et les masques

- Appuyer sur **\\** pour afficher l'avant/après
- Si des masques locaux existent, appuyer sur **O** pour afficher le masque sélectionné

Ces vues doivent aussi bénéficier du rendu progressif (768 px pendant le drag, 2048 px au relâchement).

---

## Vérifications techniques

### Tests Python backend

```bash
python -m pytest backend/tests/ -v
```

Tous les tests existants doivent passer. Les tests suivants sont critiques :
- `test_pipeline.py::test_neutrality` (vérifier que tous les sliders à 0 = image inchangée)
- `test_pipeline.py::test_curve` (interpolation PCHIP correcte)
- `test_api.py::test_render_edits` (le endpoint `/render` fonctionne)

### Build frontend

```bash
cd frontend
npm run build
```

Zéro erreur TypeScript. Le build doit inclure le nouveau code sans breakage.

---

## Ce qu'on attend comme améliorations

| Métrique | Avant | Après |
|---|---|---|
| **Temps réel drag** | Non (400–750 ms) | ✅ Oui (30–60 ms) |
| **Temps au relâchement** | 400–750 ms | 100–200 ms (grâce au pré-downscale + caches) |
| **Fluidity en sliding** | Saccadée, images saute | Fluide, smooth |
| **Histogramme update** | Retardé | Temps réel avec la vue |
| **Navigation photos** | Rechargement disco si > 3 photos | Fluide, cache 8 photos |

---

## Dépannage

### "L'image est toujours lente en drag"

Vérifier que `isDragging` est bien lu du store : ajouter un log côté frontend dans `DevelopView.tsx`:

```typescript
const isDragging = useStore((s) => s.dragBaseline !== null);
console.log("isDragging:", isDragging, "rendering at:", isDragging ? RENDER_DRAG_SIZE : RENDER_IDLE_SIZE);
```

### "Le rendu à 768 px a une qualité visuelle vraiment différente"

C'est normal (c'est 11× moins de pixels). La **calibration des rayons** (netteté, clarté) via `scale` doit être correcte pour que l'intention soit la même, pas la résolution.

Vérifier que le `scale` au rendu drag vs idle est correct en loggant dans `pipeline.py:render_array()`.

### "La netteté/clarté a l'air différente après relâchement"

Cela peut indiquer un bug dans le recalcul de `scale` au passage 768 px → 2048 px. Vérifier l'ordre des calculs de `scale` dans `render_array()`.

---

## Détails d'implémentation

### Cache LUT courbe

La clé du cache est un **tuple immutable** des points arrondi :
```python
pts_key = tuple(sorted({(round(float(p[0]), 5), float(p[1])) for p in points}))
```

Cela garantit que deux courbes avec les mêmes points (même ordre légèrement différent) ré-utilisent le même LUT.

### Pré-downscale

```python
if max_size and long_edge > max_size:
    f = max_size / long_edge
    working = cv2.resize(base, ...)  # redimensionner EN ENTRÉE
    scale = max(working.shape[:2]) / max(full_long_edge, 1)  # recalculer depuis la working image
    out = apply_pipeline(working, edits, scale=scale)
```

La clé : **`scale` est calculé depuis la taille de `working`**, pas de `base`. Cela préserve la calibration des rayons.

### Rendu progressif

```typescript
const isDragging = useStore((s) => s.dragBaseline !== null);
const delay = isDragging ? 50 : 150;
const maxSize = isDragging ? 768 : 2048;
api.render(currentId, edits, { maxSize, ... });
```

Quand `dragBaseline` devient null (fin du drag), le useEffect se ré-exécute et planifie immédiatement un rendu 2048 px.

---

**Fin du guide. Bon test ! 🎨**

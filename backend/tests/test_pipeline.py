"""Tests unitaires du pipeline de développement et des masques."""
import numpy as np
import pytest

from app import pipeline
from app.masks import build_mask
from app.pipeline import DEFAULT_EDITS, apply_pipeline, merge_edits, render_array


def gradient_image(h: int = 120, w: int = 160) -> np.ndarray:
    """Dégradé lisse coloré, float32 0..1."""
    x = np.linspace(0.05, 0.95, w, dtype=np.float32)
    y = np.linspace(0.1, 0.9, h, dtype=np.float32)
    gx, gy = np.meshgrid(x, y)
    return np.stack([gx, (gx + gy) / 2.0, gy], axis=-1)


def edits(**sections) -> dict:
    """État d'edits avec netteté neutralisée (pour comparer à l'identité)."""
    e: dict = {"detail": {"sharpen_amount": 0.0}}
    for k, v in sections.items():
        e.setdefault(k, {}).update(v) if isinstance(v, dict) else e.__setitem__(k, v)
    return e


def mean_luma(img: np.ndarray) -> float:
    return float(pipeline.luma(img).mean())


class TestMergeEdits:
    def test_empty_gives_defaults(self):
        m = merge_edits({})
        assert m["tone"]["exposure"] == 0.0
        assert m["detail"]["sharpen_amount"] == DEFAULT_EDITS["detail"]["sharpen_amount"]
        assert m["locals"] == []

    def test_partial_state(self):
        m = merge_edits({"tone": {"exposure": 1.5}})
        assert m["tone"]["exposure"] == 1.5
        assert m["tone"]["contrast"] == 0.0

    def test_local_defaults(self):
        m = merge_edits({"locals": [{"id": "a", "type": "radial",
                                     "adjust": {"exposure": 1.0}}]})
        assert m["locals"][0]["adjust"]["saturation"] == 0.0
        assert m["locals"][0]["adjust"]["exposure"] == 1.0

    def test_malformed_section_falls_back_to_default(self):
        # une section objet reçue comme scalaire (JSON corrompu/API mal formée) ne doit pas
        # remplacer le sous-dict par défaut : sinon apply_pipeline plante au prochain rendu.
        m = merge_edits({"tone": 5, "wb": None, "detail": {"sharpen_amount": 0.0}})
        assert m["tone"] == DEFAULT_EDITS["tone"]
        assert m["wb"] == DEFAULT_EDITS["wb"]
        apply_pipeline(gradient_image(), m)


class TestTonal:
    def test_neutral_is_identity(self):
        img = gradient_image()
        out = apply_pipeline(img, edits())
        assert np.abs(out - img).max() < 0.02

    def test_exposure_brightens(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(tone={"exposure": 1.0}))
        assert mean_luma(out) > mean_luma(img) + 0.1

    def test_exposure_darkens(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(tone={"exposure": -1.0}))
        assert mean_luma(out) < mean_luma(img) - 0.08

    def test_contrast_spreads_histogram(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(tone={"contrast": 60.0}))
        assert out.std() > img.std()

    def test_shadows_lift(self):
        img = gradient_image() * 0.3
        out = apply_pipeline(img, edits(tone={"shadows": 80.0}))
        assert mean_luma(out) > mean_luma(img)

    def test_highlights_recover(self):
        img = np.clip(gradient_image() + 0.5, 0, 1)
        out = apply_pipeline(img, edits(tone={"highlights": -80.0}))
        assert mean_luma(out) < mean_luma(img)

    def test_blacks_lift(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(tone={"blacks": 60.0}))
        assert float(out.min()) > float(img.min())

    def test_temperature_warms(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(wb={"temp": 60.0}))
        assert out[..., 0].mean() > img[..., 0].mean()
        assert out[..., 2].mean() < img[..., 2].mean()


class TestCurveAndColor:
    def test_curve_lut_monotone(self):
        lut = pipeline._curve_lut(((0, 0), (0.25, 0.15), (0.75, 0.9), (1, 1)))
        assert lut is not None
        assert np.all(np.diff(lut) >= -1e-6)
        assert abs(lut[0]) < 1e-3 and abs(lut[-1] - 1.0) < 1e-3

    def test_identity_curve_is_none(self):
        assert pipeline._curve_lut(((0.0, 0.0), (1.0, 1.0))) is None

    def test_channel_curve_affects_only_its_channel(self):
        # Courbe rouge seule (assombrie au milieu) : R diminue, V et B inchangés.
        img = gradient_image()
        out = apply_pipeline(img, edits(curve={"r": [[0.0, 0.0], [0.5, 0.25], [1.0, 1.0]]}))
        assert out[..., 0].mean() < img[..., 0].mean() - 1e-3
        assert np.allclose(out[..., 1], img[..., 1], atol=1e-3)
        assert np.allclose(out[..., 2], img[..., 2], atol=1e-3)

    def test_master_curve_composes_with_channel(self):
        # Maître = identité décalée + canal : l'application reste dans [0,1] et bouge les 3 canaux.
        img = gradient_image()
        out = apply_pipeline(img, edits(curve={"points": [[0.0, 0.05], [1.0, 1.0]]}))
        assert out.min() >= 0.0 and out.max() <= 1.0
        assert out[..., 2].mean() > img[..., 2].mean() - 1e-2

    def test_wb_pick_neutralizes_cast(self):
        # zone uniforme avec un voile bleuté : la pipette doit renvoyer un temp/teinte
        # qui ramène le point cliqué vers le neutre (R≈V≈B).
        img = np.empty((20, 20, 3), np.float32)
        img[..., 0], img[..., 1], img[..., 2] = 0.48, 0.50, 0.55
        res = pipeline.wb_from_point(img, {}, 0.5, 0.5)
        assert -100.0 <= res["temp"] <= 100.0 and -100.0 <= res["tint"] <= 100.0
        out = apply_pipeline(img, merge_edits({"wb": res, "detail": {"sharpen_amount": 0.0}}))
        c = out[10, 10]
        assert float(c.max() - c.min()) < 0.01

    def test_wb_pick_neutral_is_zero(self):
        img = np.full((20, 20, 3), 0.5, np.float32)
        res = pipeline.wb_from_point(img, {}, 0.5, 0.5)
        assert abs(res["temp"]) < 1e-6 and abs(res["tint"]) < 1e-6

    def test_hsl_pick_finds_nearest_band(self):
        # patch rouge saturé au centre : la pipette doit désigner la bande "red" (centre 0°).
        img = np.full((20, 20, 3), 0.5, np.float32)
        img[8:12, 8:12] = [0.8, 0.1, 0.1]
        res = pipeline.hsl_band_from_point(img, {}, 0.5, 0.5)
        assert res["band"] == "red"
        assert res["saturation"] > 0.5

        # patch bleu saturé : bande "blue" (centre 240°).
        img2 = np.full((20, 20, 3), 0.5, np.float32)
        img2[8:12, 8:12] = [0.1, 0.1, 0.8]
        res2 = pipeline.hsl_band_from_point(img2, {}, 0.5, 0.5)
        assert res2["band"] == "blue"

    def test_hsl_pick_neutral_patch_is_low_saturation(self):
        img = np.full((20, 20, 3), 0.5, np.float32)
        res = pipeline.hsl_band_from_point(img, {}, 0.5, 0.5)
        assert res["saturation"] < 0.05

    def test_defringe_reduces_edge_fringe(self):
        # bord net avec frange pourpre (R,B hauts, V bas) sur les colonnes du bord
        img = np.zeros((20, 20, 3), np.float32)
        img[:, 10:] = 0.8
        img[:, 9:11, 0] = 0.7
        img[:, 9:11, 1] = 0.2
        img[:, 9:11, 2] = 0.7
        fr_before = float((img[:, 9:11, 0] - img[:, 9:11, 1]).mean())
        out = apply_pipeline(img, edits(detail={"defringe_purple": 100.0}))
        fr_after = float((out[:, 9:11, 0] - out[:, 9:11, 1]).mean())
        assert fr_after < fr_before - 0.05          # frange pourpre nettement atténuée
        # neutralité : sans réglage, l'image est inchangée
        out0 = apply_pipeline(img.copy(), edits())
        assert np.allclose(out0, img, atol=2e-3)

    def test_desaturation_gives_gray(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(presence={"saturation": -100.0}))
        assert np.abs(out[..., 0] - out[..., 1]).max() < 0.02
        assert np.abs(out[..., 1] - out[..., 2]).max() < 0.02

    def test_vibrance_increases_saturation(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(presence={"vibrance": 80.0}))
        spread = lambda a: (a.max(axis=-1) - a.min(axis=-1)).mean()
        assert spread(out) > spread(img)

    def test_hsl_targets_band(self):
        img = np.zeros((40, 40, 3), np.float32)
        img[:20] = [0.8, 0.1, 0.1]   # rouge
        img[20:] = [0.1, 0.1, 0.8]   # bleu
        e = edits()
        e["hsl"] = {"red": {"h": 0, "s": -100, "l": 0}}
        out = apply_pipeline(img, e)
        red_sat = float(out[:20].max(axis=-1).mean() - out[:20].min(axis=-1).mean())
        blue_sat = float(out[20:].max(axis=-1).mean() - out[20:].min(axis=-1).mean())
        assert red_sat < 0.25
        assert blue_sat > 0.5


class TestDetailEffects:
    def test_sharpen_amplifies_edges(self):
        img = gradient_image()
        img[:, 80:] += 0.2  # bord franc
        img = np.clip(img, 0, 1)
        out = apply_pipeline(img, {"detail": {"sharpen_amount": 120.0, "sharpen_radius": 1.5}})
        edge_in = float(np.abs(np.diff(pipeline.luma(img), axis=1)).max())
        edge_out = float(np.abs(np.diff(pipeline.luma(out), axis=1)).max())
        assert edge_out > edge_in

    def test_nr_smooths_noise(self):
        rng = np.random.default_rng(0)
        img = np.clip(gradient_image() + rng.normal(0, 0.06, (120, 160, 3)).astype(np.float32), 0, 1)
        out = apply_pipeline(img, edits(detail={"nr_luma": 80.0, "sharpen_amount": 0.0}))
        hp = lambda a: float(np.abs(np.diff(pipeline.luma(a), axis=0)).mean())
        assert hp(out) < hp(img)

    def test_vignette_darkens_corners(self):
        img = np.full((100, 150, 3), 0.6, np.float32)
        out = apply_pipeline(img, edits(effects={"vignette": -80.0}))
        assert out[0, 0].mean() < out[50, 75].mean() - 0.05

    def test_grain_adds_noise(self):
        img = np.full((80, 80, 3), 0.5, np.float32)
        out = apply_pipeline(img, edits(effects={"grain": 60.0}))
        assert out.std() > 0.005


class TestGeometry:
    def test_rotate_swaps_dims(self):
        img = gradient_image(100, 160)
        out = apply_pipeline(img, edits(geometry={"rotate": 90}))
        assert out.shape[:2] == (160, 100)

    def test_crop(self):
        img = gradient_image(100, 160)
        out = apply_pipeline(img, edits(geometry={"crop": {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}}))
        assert out.shape[0] == pytest.approx(50, abs=2)
        assert out.shape[1] == pytest.approx(80, abs=2)

    def test_straighten_keeps_aspect(self):
        img = gradient_image(120, 180)
        out = apply_pipeline(img, edits(geometry={"straighten": 5.0}))
        assert 0 < out.shape[0] < 120
        assert out.shape[1] / out.shape[0] == pytest.approx(1.5, rel=0.05)

    def test_flip(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(geometry={"flip_h": True}, detail={"sharpen_amount": 0.0}))
        assert np.abs(out - img[:, ::-1]).max() < 0.02


class TestMasks:
    def test_radial_center_vs_corner(self):
        m = build_mask({"type": "radial", "params": {"cx": 0.5, "cy": 0.5, "rx": 0.2, "ry": 0.2},
                        "invert": False}, 100, 100)
        assert m[50, 50] > 0.9
        assert m[2, 2] < 0.05

    def test_radial_invert(self):
        m = build_mask({"type": "radial", "params": {"cx": 0.5, "cy": 0.5, "rx": 0.2, "ry": 0.2},
                        "invert": True}, 100, 100)
        assert m[50, 50] < 0.1
        assert m[2, 2] > 0.95

    def test_linear_gradient_direction(self):
        m = build_mask({"type": "linear",
                        "params": {"x0": 0.5, "y0": 0.0, "x1": 0.5, "y1": 1.0}}, 100, 100)
        assert m[2, 50] > 0.95   # côté départ
        assert m[97, 50] < 0.05  # côté arrivée
        assert m[2, 50] > m[50, 50] > m[97, 50]

    def test_brush_paints_where_stroked(self):
        m = build_mask({"type": "brush", "params": {
            "feather": 0.3,
            "strokes": [{"points": [[0.2, 0.5], [0.8, 0.5]], "size": 0.1}]}}, 100, 200)
        assert m[50, 100] > 0.8
        assert m[5, 100] < 0.05

    def test_brush_handles_non_finite_points(self):
        # points NaN/Infinity (edits corrompus en amont) ne doivent pas planter le rendu
        # (int(round(nan)) lève ValueError, int(round(inf)) lève OverflowError sans le garde).
        m = build_mask({"type": "brush", "params": {
            "feather": 0.3,
            "strokes": [{"points": [[float("nan"), 0.5], [float("inf"), 0.5]], "size": 0.1}]}}, 100, 200)
        assert m is not None
        assert np.isfinite(m).all()

    def test_linear_radial_lumrange_colorrange_handle_non_finite_params(self):
        # même classe de bug que le pinceau : un paramètre NaN/Infinity ne fait pas planter
        # ces masques (pas d'int()/round() ici), mais NaN se propageait silencieusement dans le
        # masque puis l'image finale (pixels corrompus, sans erreur visible) — corrigé via _finite.
        img = np.random.rand(50, 50, 3).astype(np.float32)
        m = build_mask({"type": "linear",
                        "params": {"x0": float("nan"), "y0": 0.2, "x1": 0.5, "y1": 0.8}}, 50, 50)
        assert np.isfinite(m).all()
        m = build_mask({"type": "radial",
                        "params": {"cx": float("nan"), "cy": 0.5, "rx": 0.3, "ry": 0.3}}, 50, 50)
        assert np.isfinite(m).all()
        m = build_mask({"type": "lumrange", "params": {"lo": float("nan"), "hi": 0.6}}, 50, 50, img)
        assert np.isfinite(m).all()
        m = build_mask({"type": "colorrange", "params": {"hue": float("nan"), "range": 30}}, 50, 50, img)
        assert np.isfinite(m).all()

    def test_unknown_type(self):
        assert build_mask({"type": "nope", "params": {}}, 10, 10) is None

    def test_lumrange_selects_band(self):
        # rampe verticale de luminance 0→1 ; la plage [0.4,0.6] ne retient que le milieu
        img = np.zeros((100, 10, 3), np.float32)
        img[:] = np.linspace(0.0, 1.0, 100, dtype=np.float32)[:, None, None]
        m = build_mask({"type": "lumrange", "params": {"lo": 0.4, "hi": 0.6, "smooth": 0.05}}, 100, 10, img)
        assert m is not None
        assert m[50, 5] > 0.9      # milieu (≈0.5) sélectionné
        assert m[5, 5] < 0.05      # ombres exclues
        assert m[95, 5] < 0.05     # hautes lumières exclues
        # sans image, un masque par plage est nul (pas d'effet)
        assert build_mask({"type": "lumrange", "params": {}}, 10, 10) is None

    def test_colorrange_selects_hue(self):
        # moitié rouge / moitié bleue ; cibler le rouge ne retient que la moitié rouge
        img = np.zeros((40, 40, 3), np.float32)
        img[:20] = [0.8, 0.1, 0.1]
        img[20:] = [0.1, 0.1, 0.8]
        m = build_mask({"type": "colorrange",
                        "params": {"hue": 0.0, "range": 30.0, "smooth": 15.0, "sat_min": 0.2}}, 40, 40, img)
        assert m is not None
        assert m[5, 20] > 0.8      # rouge ciblé
        assert m[35, 20] < 0.1     # bleu exclu

    def test_ai_mask_loads_and_resizes(self, tmp_path, monkeypatch):
        import cv2
        from app import config, masks
        # bitmap 1/4 blanc (haut-gauche) stocké comme un masque IA
        store = tmp_path / "masks"
        (store / "7").mkdir(parents=True)
        bmp = np.zeros((50, 50), np.uint8)
        bmp[:25, :25] = 255
        cv2.imwrite(str(store / "7" / "ai-x.png"), bmp)
        monkeypatch.setattr(config, "MASKS_DIR", store)
        monkeypatch.setattr(masks.config, "MASKS_DIR", store)
        m = build_mask({"type": "ai", "params": {"ref": "7/ai-x.png"}}, 100, 100)
        assert m is not None
        assert m[10, 10] > 0.9       # zone blanche (agrandie)
        assert m[90, 90] < 0.1       # zone noire

    def test_ai_mask_missing_ref(self):
        assert build_mask({"type": "ai", "params": {"ref": "nope/none.png"}}, 10, 10) is None
        assert build_mask({"type": "ai", "params": {}}, 10, 10) is None

    def test_ai_mask_hardness_sharpens(self, tmp_path, monkeypatch):
        import cv2
        from app import config, masks
        store = tmp_path / "masks"
        (store / "3").mkdir(parents=True)
        # dégradé horizontal 0→1 : la dureté doit accentuer le contraste autour de 0.5
        grad = (np.linspace(0, 255, 50).astype(np.uint8))[None].repeat(50, 0)
        cv2.imwrite(str(store / "3" / "ai-g.png"), grad)
        monkeypatch.setattr(config, "MASKS_DIR", store)
        monkeypatch.setattr(masks.config, "MASKS_DIR", store)
        soft = build_mask({"type": "ai", "params": {"ref": "3/ai-g.png", "hardness": 0}}, 50, 50)
        hard = build_mask({"type": "ai", "params": {"ref": "3/ai-g.png", "hardness": 100}}, 50, 50)
        # côté sombre plus proche de 0, côté clair plus proche de 1 quand on durcit
        assert hard[25, 8] < soft[25, 8]
        assert hard[25, 41] > soft[25, 41]

    def test_inpaint_mask_same_shape_as_brush(self):
        params = {"feather": 0.3, "strokes": [{"points": [[0.5, 0.5]], "size": 0.2}]}
        m_inpaint = build_mask({"type": "inpaint", "params": params, "invert": False}, 100, 100)
        m_brush = build_mask({"type": "brush", "params": params, "invert": False}, 100, 100)
        assert np.array_equal(m_inpaint, m_brush)


class TestLocals:
    def test_radial_exposure_only_affects_inside(self):
        img = np.full((100, 100, 3), 0.3, np.float32)
        e = edits()
        e["locals"] = [{"id": "x", "type": "radial",
                        "params": {"cx": 0.5, "cy": 0.5, "rx": 0.25, "ry": 0.25, "feather": 0.2},
                        "adjust": {"exposure": 1.5}}]
        out = apply_pipeline(img, e)
        assert out[50, 50].mean() > 0.45
        assert abs(out[2, 2].mean() - 0.3) < 0.03

    def test_inpaint_blends_stored_patch_onto_destination(self, tmp_path, monkeypatch):
        # Le patch stocké (calculé une fois côté endpoint /inpaint, pas ici) est un simple PNG RGB
        # sous MASKS_DIR — _apply_inpaint n'a pas besoin du vrai modèle ONNX pour être testé, tout
        # comme _ai_mask (masques IA sujet/clic) n'a pas besoin de segment.py dans ses tests.
        import cv2
        from app import config
        store = tmp_path / "masks"
        (store / "9").mkdir(parents=True)
        patch = np.zeros((40, 40, 3), np.uint8)
        patch[:] = [10, 200, 10]  # BGR vert vif (cv2.imwrite attend BGR)
        cv2.imwrite(str(store / "9" / "inpaint-x.png"), patch)
        monkeypatch.setattr(config, "MASKS_DIR", store)
        monkeypatch.setattr(pipeline.config, "MASKS_DIR", store)

        img = np.full((100, 100, 3), 0.3, np.float32)
        e = edits()
        e["locals"] = [{"id": "s", "type": "inpaint",
                        "params": {"feather": 0.1,
                                   "strokes": [{"points": [[0.25, 0.5]], "size": 0.2}],
                                   "ref": "9/inpaint-x.png"}, "adjust": {}}]
        out = apply_pipeline(img, e)
        assert out[50, 25, 1] > 0.6   # zone destination : vert du patch
        assert out[50, 25, 0] < 0.2
        assert abs(out[10, 10, 0] - 0.3) < 0.03   # hors masque : inchangé

    def test_inpaint_opacity_partial_blend(self, tmp_path, monkeypatch):
        import cv2
        from app import config
        store = tmp_path / "masks"
        (store / "9").mkdir(parents=True)
        patch = np.zeros((40, 40, 3), np.uint8)
        patch[:] = [10, 200, 10]
        cv2.imwrite(str(store / "9" / "inpaint-x.png"), patch)
        monkeypatch.setattr(config, "MASKS_DIR", store)
        monkeypatch.setattr(pipeline.config, "MASKS_DIR", store)

        img = np.full((100, 100, 3), 0.3, np.float32)
        e = edits()
        e["locals"] = [{"id": "s", "type": "inpaint",
                        "params": {"feather": 0.0,
                                   "strokes": [{"points": [[0.25, 0.5]], "size": 0.2}],
                                   "ref": "9/inpaint-x.png", "opacity": 0.5}, "adjust": {}}]
        out = apply_pipeline(img, e)
        assert 0.3 < out[50, 25, 1] < 0.78   # blend partiel, ni le fond ni le patch purs

    def test_inpaint_missing_ref_is_noop(self):
        img = np.full((30, 30, 3), 0.3, np.float32)
        e = edits()
        e["locals"] = [{"id": "s", "type": "inpaint",
                        "params": {"strokes": [{"points": [[0.5, 0.5]], "size": 0.4}]}, "adjust": {}}]
        out = apply_pipeline(img, e)  # pas de ref → ne doit pas planter, image inchangée
        assert np.abs(out - img).max() < 1e-5

    def test_inpaint_uses_rect_to_reproject_patch(self, tmp_path, monkeypatch):
        # Le patch stocké couvre le rectangle de CONTEXTE (avec halo), pas la bbox du masque —
        # reproduit le scénario réel de l'endpoint /inpaint (cf. edits.py) : sans reprojection via
        # `params.rect`, le patch entier serait étiré dans la bbox du masque et un contenu situé
        # hors de la zone corrigée (ici : moitié gauche noire du patch) apparaîtrait à tort dans
        # la destination.
        import cv2
        from app import config
        store = tmp_path / "masks"
        (store / "9").mkdir(parents=True)
        # Patch 80x40 : moitié gauche noire, moitié droite verte (BGR pour cv2.imwrite).
        patch = np.zeros((40, 80, 3), np.uint8)
        patch[:, 40:] = [10, 200, 10]
        cv2.imwrite(str(store / "9" / "inpaint-x.png"), patch)
        monkeypatch.setattr(config, "MASKS_DIR", store)
        monkeypatch.setattr(pipeline.config, "MASKS_DIR", store)

        img = np.full((100, 100, 3), 0.3, np.float32)
        e = edits()
        # rect = rectangle de contexte capturé côté serveur, plus étroit que le patch et décalé :
        # au centre du masque (cx=0.25), la reprojection doit tomber dans la moitié droite (verte)
        # du patch, avec une marge confortable pour ne pas dépendre d'un arrondi de pixel.
        e["locals"] = [{"id": "s", "type": "inpaint",
                        "params": {"feather": 0.0,
                                   "strokes": [{"points": [[0.25, 0.5]], "size": 0.2}],
                                   "ref": "9/inpaint-x.png", "rect": [0.15, 0.0, 0.30, 1.0]},
                        "adjust": {}}]
        out = apply_pipeline(img, e)
        assert out[50, 25, 1] > 0.6   # vert du patch (moitié droite du rect), pas du noir
        assert out[50, 25, 0] < 0.2


class TestRenderAndAuto:
    def test_render_array_resizes(self):
        img = gradient_image(400, 600)
        out = render_array(img, {}, max_size=200, full_long_edge=600)
        assert out.dtype == np.uint8
        assert max(out.shape[:2]) == 200

    def test_render_with_mask_overlay(self):
        img = gradient_image(100, 100)
        e = {"locals": [{"id": "m1", "type": "radial",
                         "params": {"cx": 0.5, "cy": 0.5, "rx": 0.3, "ry": 0.3},
                         "adjust": {"exposure": 0.5}}]}
        out = render_array(img, e, max_size=100, full_long_edge=100, show_mask="m1")
        center = out[50, 50].astype(int)
        assert center[0] > center[2]  # surimpression rouge

    def test_encode_jpeg(self):
        data = pipeline.encode_jpeg(np.zeros((10, 10, 3), np.uint8))
        assert data[:2] == b"\xff\xd8"

    def test_auto_adjust_bounded(self):
        img = gradient_image() * 0.2  # sous-exposé
        e = pipeline.auto_adjust(img, {})
        assert 0 < e["tone"]["exposure"] <= 2.5
        assert -100 <= e["wb"]["temp"] <= 100

    def test_dehaze_runs(self):
        img = np.clip(gradient_image() * 0.5 + 0.4, 0, 1)
        out = apply_pipeline(img, edits(presence={"dehaze": 60.0}))
        assert out.shape == img.shape
        assert np.isfinite(out).all()


class TestGrain:
    """B8 — grain : déterministe par graine, motif différent entre photos, mis à l'échelle."""

    def test_grain_off_is_noop(self):
        img = gradient_image()
        out = apply_pipeline(img, edits(effects={"grain": 0.0}), seed=42)
        assert np.allclose(out, np.clip(apply_pipeline(img, edits()), 0, 1))

    def test_grain_same_seed_deterministic(self):
        img = gradient_image()
        a = apply_pipeline(img, edits(effects={"grain": 50.0}), seed=7)
        b = apply_pipeline(img, edits(effects={"grain": 50.0}), seed=7)
        assert np.array_equal(a, b)

    def test_grain_differs_by_seed(self):
        img = gradient_image()
        a = apply_pipeline(img, edits(effects={"grain": 50.0}), seed=1)
        b = apply_pipeline(img, edits(effects={"grain": 50.0}), seed=2)
        # Motif différent d'une photo à l'autre (plus de graine fixe partagée).
        assert not np.array_equal(a, b)

    def test_grain_actually_perturbs(self):
        img = gradient_image()
        clean = apply_pipeline(img, edits())
        grainy = apply_pipeline(img, edits(effects={"grain": 80.0}), seed=3)
        assert float(np.abs(grainy - np.clip(clean, 0, 1)).mean()) > 1e-4

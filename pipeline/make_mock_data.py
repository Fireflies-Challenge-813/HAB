"""
make_mock_data.py: generate MOCK data in the contract format, so the dashboard
can be built before the real pipeline is ready.

Everything here is invented: blob-shaped "blooms", made-up spectra, example sites.
Every scene is written with status "mock", and the dashboard shows a Mock data badge.

It deliberately goes through the same export_contract.py functions the real
pipeline uses (including a south-to-north latitude array, like xarray gives you),
so the mock files are guaranteed to match the contract.

    pip install numpy global-land-mask
    python pipeline/make_mock_data.py
"""

import json
import os

import numpy as np
from global_land_mask import globe

import export_contract as ec

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

PACE_WL = np.array([w for w in range(400, 716, 5) if not 590 <= w <= 610], dtype=float)
MODIS_WL = np.array([412, 443, 469, 488, 531, 547, 555, 645, 667, 678, 748], dtype=float)


# --- made-up spectral shapes (Rrs, sr^-1) -----------------------------------
def shape_clear(w):
    return 0.0075 * np.exp(-(w - 400) / 70) + 0.0004


def shape_bloom(w):
    return (0.0009 + 0.0011 * np.exp(-((w - 440) / 45) ** 2)
            + 0.0042 * np.exp(-((w - 555) / 38) ** 2) + 0.0010 * np.exp(-((w - 683) / 11) ** 2))


def shape_cp(w):
    return (0.0012 + 0.0034 * np.exp(-((w - 580) / 48) ** 2)
            + 0.0022 * np.exp(-((w - 683) / 11) ** 2) + 0.0006 * np.exp(-((w - 640) / 25) ** 2))


# --- field helpers -----------------------------------------------------------
def smooth_noise(shape, rng, passes=6):
    a = rng.standard_normal(shape)
    for _ in range(passes):
        a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1)) / 5
    return (a - a.mean()) / (a.std() + 1e-9)


def blob(LON, LAT, cx, cy, sx, sy, theta=0.0):
    x, y = LON - cx, LAT - cy
    c, s = np.cos(theta), np.sin(theta)
    xr, yr = c * x + s * y, -s * x + c * y
    return np.exp(-0.5 * ((xr / sx) ** 2 + (yr / sy) ** 2))


def swirl(LON, LAT, cx, cy, r, arms=3, twist=6.0):
    x, y = LON - cx, LAT - cy
    d = np.hypot(x, y)
    ang = np.arctan2(y, x)
    return np.exp(-(d / r) ** 2) * (0.5 + 0.5 * np.sin(arms * ang + twist * d / r))


def near_land(land, cells):
    out = land.copy()
    for _ in range(cells):
        out = out | np.roll(out, 1, 0) | np.roll(out, -1, 0) | np.roll(out, 1, 1) | np.roll(out, -1, 1)
    return out & ~land


# --- one scene ---------------------------------------------------------------
def make_scene(scene_id, res, blooms, cps, clouds, meta, seed, shallow_box=None, with_sam=False):
    region, sensor, _ = ec.SCENE_ID_RE.match(scene_id).groups()
    west, south, east, north = ec.REGIONS[region]["bbox"]
    W, H = round((east - west) / res), round((north - south) / res)
    lon = west + (np.arange(W) + 0.5) * res
    lat = south + (np.arange(H) + 0.5) * res          # south -> north, like xarray
    LON, LAT = np.meshgrid(lon, lat)
    rng = np.random.default_rng(seed)

    land = globe.is_land(LAT, LON)
    B = np.zeros_like(LON)
    C = np.zeros_like(LON)
    for kind, args in blooms:
        B = np.maximum(B, (swirl if kind == "swirl" else blob)(LON, LAT, *args))
    for args in cps:
        C = np.maximum(C, blob(LON, LAT, *args))
    B = np.clip(B * (1 + 0.25 * smooth_noise(B.shape, rng)), 0, 1)
    C = np.clip(C * (1 + 0.25 * smooth_noise(C.shape, rng)), 0, 1)

    ratio = 0.32 + 0.05 * smooth_noise(LON.shape, rng)
    nflh = 0.012 + 0.004 * smooth_noise(LON.shape, rng)
    w = np.clip(np.maximum(B, C) * 1.6, 0, 1)
    target = np.where(C >= B, 0.95 + 0.6 * C, 0.55 + 0.3 * B)
    ratio = ratio * (1 - w) + target * w
    nflh = nflh + 0.09 * B + 0.11 * C

    cloud = np.zeros_like(land)
    for cx, cy, sx, sy in clouds:
        cloud |= (blob(LON, LAT, cx, cy, sx, sy) * (1 + 0.5 * smooth_noise(LON.shape, rng))) > 0.55
    shallow = np.zeros_like(land)
    if shallow_box:
        bw, bs, be, bn = shallow_box
        shallow = near_land(land, 2) & (LON >= bw) & (LON <= be) & (LAT >= bs) & (LAT <= bn)

    ratio[land | cloud] = np.nan
    nflh[land | cloud] = np.nan
    code = ec.classify(ratio, nflh, land, cloud, shallow)

    sam = None
    if with_sam:
        sam = np.clip(33 - 25 * C - 14 * B + 2.5 * smooth_noise(LON.shape, rng), 2, 45)
        sam[code < 3] = np.nan

    wl = PACE_WL if sensor == "pace" else MODIS_WL
    wB = np.clip(B, 0, 1)[..., None]
    wC = np.clip(C, 0, 1)[..., None]
    wO = np.clip(1 - wB - wC, 0, 1)
    cube = wO * shape_clear(wl) + wB * shape_bloom(wl) + wC * shape_cp(wl)
    cube = cube * (1 + 0.03 * rng.standard_normal(cube.shape))
    cube[land | cloud] = np.nan

    bbox, resd, (code, ratio, nflh, sam, cube) = ec.orient_grid(lat, lon, code, ratio, nflh, sam, cube)
    ec.write_grid(DATA_DIR, scene_id, bbox, resd, code, ratio, nflh, sam_deg=sam)
    probes, means = ec.pick_probes(bbox, resd, code, ratio, cube, per_class=8, seed=seed)
    ec.write_spectra(DATA_DIR, scene_id, wl, probes, means)

    bands = ({"ratio_num": 667.5, "ratio_den": 442.5, "flh_peak": 677.5, "flh_base_low": 667.5, "flh_base_high": 717.5}
             if sensor == "pace" else
             {"ratio_num": 667.0, "ratio_den": 443.0, "flh_peak": 678.0, "flh_base_low": 667.0, "flh_base_high": 748.0})
    ec.update_manifest(DATA_DIR, dict(meta, scene_id=scene_id, status="mock", bands_used_nm=bands,
                                      f0_source="mock", product="MOCK (generated by make_mock_data.py)"))


def write_example_sites():
    path = os.path.join(DATA_DIR, "sites.geojson")
    if os.path.exists(path):
        print(f"kept existing {path}")
        return
    sites = [
        ("gulf_desal_01", "Example desalination intake 1", "desalination", "gulf", 56.40, 25.13),
        ("gulf_desal_02", "Example desalination intake 2", "desalination", "gulf", 55.00, 25.05),
        ("gulf_desal_03", "Example desalination intake 3", "desalination", "gulf", 56.80, 24.42),
        ("gulf_aqua_01", "Example fish farm 1", "aquaculture", "gulf", 56.30, 26.15),
        ("gulf_beach_01", "Example public beach 1", "beach", "gulf", 54.33, 24.50),
        ("korea_aqua_01", "Example fish farm K1", "aquaculture", "korea", 128.40, 34.80),
        ("korea_aqua_02", "Example fish farm K2", "aquaculture", "korea", 127.80, 34.68),
        ("korea_beach_01", "Example beach K1", "beach", "korea", 129.16, 35.15),
    ]
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
         "properties": {"site_id": sid, "name": name, "type": t, "region": r}}
        for sid, name, t, r, lon, lat in sites]}
    with open(path, "w") as f:
        json.dump(fc, f, indent=1)
    print(f"wrote {path} (example sites: replace with real ones)")


def main():
    os.makedirs(os.path.join(DATA_DIR, "scenes"), exist_ok=True)
    ref_wl = np.arange(400, 701, 5, dtype=float)
    ec.write_references(DATA_DIR, [{
        "ref_id": "cp_korea",
        "label": "C. polykrikoides reference (PLACEHOLDER)",
        "source": "PLACEHOLDER: replace with the published Korean field spectrum and its citation",
        "source_url": None,
        "wavelengths_nm": ref_wl.tolist(),
        "rrs": np.round(shape_cp(ref_wl), 5).tolist(),
        "notes": "Invented shape for building the interface. Not a measurement.",
    }])

    make_scene(
        "gulf_pace_20250308", 1 / 24,
        blooms=[("swirl", (58.3, 24.75, 1.1, 3, 7.0)), ("blob", (57.4, 25.0, 0.35, 0.18, 0.4))],
        cps=[], clouds=[(50.2, 28.6, 0.8, 0.5), (53.0, 26.3, 0.5, 0.3)],
        shallow_box=(50.5, 23.8, 54.6, 25.6), with_sam=True, seed=1,
        meta={"role": "probable_negative_test", "title": "Gulf of Oman swirls",
              "context": "NASA Earth Observatory: swirls that likely include Noctiluca (not confirmed by sampling). "
                         "The pipeline should NOT flag C. polykrikoides here.",
              "source_url": "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/"})

    make_scene(
        "korea_pace_20260810", 1 / 48,
        blooms=[("blob", (128.75, 34.15, 0.25, 0.12, 0.3))],
        cps=[(127.75, 34.60, 0.14, 0.06, 0.2), (128.15, 34.72, 0.12, 0.05, -0.2), (128.50, 34.78, 0.10, 0.05, 0.0)],
        clouds=[(126.3, 33.9, 0.4, 0.3)], with_sam=True, seed=2,
        meta={"role": "true_positive_test", "title": "South Sea red tide alert",
              "context": "NIFS 'Caution' red tide alert for M. polykrikoides along the South Sea coast "
                         "(eastern South Jeolla, western South Gyeongsang), August 2026.",
              "source_url": "https://www.techtimes.com/articles/323801/20260810/south-koreas-gill-clogging-red-tide-alert-threatens-fish-farms-already-battered-heat.htm"})

    meta_2008 = {"role": "implementation_check",
                 "context": "Documented C. polykrikoides bloom, Gulf of Oman and Arabian Gulf, 2008-09. "
                            "Checks that our code reproduces Ghanea et al. (2016); it does not validate the rule.",
                 "source_url": "https://www.sciencedirect.com/science/article/abs/pii/S1568988309001048"}
    make_scene(
        "gulf_modis_20081020", 1 / 24,
        blooms=[("blob", (52.5, 27.4, 0.4, 0.2, 0.5))],
        cps=[(56.62, 25.20, 0.22, 0.35, 0.3), (57.25, 25.05, 0.30, 0.20, 0.0)],
        clouds=[(49.5, 29.4, 0.5, 0.4)], shallow_box=(50.5, 23.8, 54.6, 25.6), seed=3,
        meta=dict(meta_2008, title="2008 red tide, early stage"))
    make_scene(
        "gulf_modis_20081215", 1 / 24,
        blooms=[("blob", (51.6, 27.8, 0.5, 0.25, 0.4))],
        cps=[(56.55, 25.40, 0.25, 0.55, 0.3), (56.45, 26.35, 0.35, 0.22, 0.0),
             (55.30, 25.75, 0.45, 0.22, 0.5), (57.30, 25.10, 0.45, 0.25, 0.0)],
        clouds=[(58.8, 23.2, 0.4, 0.3)], shallow_box=(50.5, 23.8, 54.6, 25.6), seed=4,
        meta=dict(meta_2008, title="2008 red tide, peak"))

    write_example_sites()


if __name__ == "__main__":
    main()

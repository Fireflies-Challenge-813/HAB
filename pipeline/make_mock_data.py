"""
make_mock_data.py: generate MOCK data in the contract format, for the dashboard's full
check suite (npm run dev:mock, then npm run check against it).

Everything here is invented: placeholder reference spectra, made-up clusters,
blob-shaped "blooms", a made-up depth field. Every scene is written with status "mock",
and the dashboard shows a Mock data badge. It writes to mock-data/, never to data/,
which holds the real data; the sites are copied from data/sites.geojson.

It deliberately goes through the same export_contract.py functions the real
pipeline uses (including a south-to-north latitude array, like xarray gives you),
so the mock files are guaranteed to match the contract.

    pip install numpy global-land-mask
    python pipeline/make_mock_data.py                 # into mock-data/
    python pipeline/make_mock_data.py --out <folder>  # somewhere else
    python pipeline/make_mock_data.py --fetch-depth   # once: sample real GEBCO depths (~8 min, needs internet)
"""

import json
import math
import os
import shutil
import sys
import time
import urllib.request

import numpy as np
from global_land_mask import globe

import export_contract as ec

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
REAL_DATA_DIR = os.path.join(ROOT, "data")
DATA_DIR = os.path.join(ROOT, "mock-data")  # set from --out in main()
# Real GEBCO 2020 elevations sampled every 0.02 deg over the area (made by --fetch-depth),
# so the mock shallow mask has the true shape of the seabed. Without it, depth is invented.
DEPTH_SAMPLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock_depth_gebco.json")
DEPTH_SAMPLE_RES = 0.02
RES = 0.01
KM_PER_CELL = RES * 105  # rough, between the lon and lat spacing at 25 N

PACE_WL = np.array([w for w in range(400, 716, 5) if not 590 <= w <= 610], dtype=float)
REF_WL = np.arange(400, 701, 5, dtype=float)


# --- made-up spectral shapes (Rrs, sr^-1) -----------------------------------
def g(w, center, width):
    return np.exp(-(((w - center) / width) ** 2))


SHAPES = {
    "water_clear": lambda w: 0.0075 * np.exp(-(w - 400) / 70) + 0.0004,
    "water_turbid": lambda w: 0.0030 + 0.0060 / (1 + np.exp(-(w - 490) / 22)) - 0.0008 * g(w, 683, 12),
    "seabed": lambda w: 0.0015 + 0.0110 / (1 + np.exp(-(w - 540) / 30)) - 0.0010 * g(w, 420, 40),
    "cp": lambda w: 0.0012 + 0.0034 * g(w, 580, 48) + 0.0022 * g(w, 683, 11) + 0.0006 * g(w, 640, 25),
    "noctiluca_green": lambda w: 0.0009 + 0.0011 * g(w, 440, 45) + 0.0042 * g(w, 540, 34) + 0.0010 * g(w, 683, 11),
    "diatom": lambda w: 0.0010 + 0.0016 * g(w, 490, 30) + 0.0026 * g(w, 570, 40) + 0.0016 * g(w, 683, 13),
}

REFERENCE_INFO = {
    "cp": ("C. polykrikoides (PLACEHOLDER)", "PLACEHOLDER: Kim, Yoo & Son (2016), Korean field spectra, digitized"),
    "noctiluca_green": ("Green Noctiluca (PLACEHOLDER)", "PLACEHOLDER: Dwivedi et al. (2015), Northern Arabian Sea, digitized"),
    "diatom": ("Diatom bloom (PLACEHOLDER)", "PLACEHOLDER: Dwivedi et al. (2015), Northern Arabian Sea, digitized"),
    "water_clear": ("Clear offshore water (PLACEHOLDER)", "PLACEHOLDER: mean of clear offshore pixels from our analysis dates"),
    "water_turbid": ("Turbid coastal water (PLACEHOLDER)", "PLACEHOLDER: mean of turbid coastal pixels from our analysis dates"),
    "seabed": ("Shallow seabed (PLACEHOLDER)", "PLACEHOLDER: mean of 5-15 m deep pixels on our analysis dates"),
}

# Mock clusters: (cluster_id, parent_id, kind, mixture of shapes). The kind decides
# where the cluster appears in a scene; the name comes from its angles, like the real thing.
CLUSTER_RECIPES = [
    (0, 0, "clear", {"water_clear": 1.0}),
    (1, 0, "clear", {"water_clear": 0.9, "water_turbid": 0.1}),
    (2, 0, "clear", {"water_clear": 0.8, "noctiluca_green": 0.2}),
    (3, 0, "clear", {"water_clear": 0.85, "diatom": 0.15}),
    (4, 1, "turbid", {"water_turbid": 1.0}),
    (5, 1, "turbid", {"water_turbid": 0.8, "water_clear": 0.2}),
    (6, 1, "turbid", {"water_turbid": 0.7, "diatom": 0.3}),
    (7, 1, "seabed", {"seabed": 0.9, "water_turbid": 0.1}),
    (8, 1, "seabed", {"seabed": 0.7, "water_clear": 0.3}),
    (9, 2, "cp", {"cp": 1.0}),
    (10, 2, "cp", {"cp": 0.85, "water_clear": 0.15}),
    (11, 2, "cp", {"cp": 0.75, "diatom": 0.25}),
    (12, 2, "cp", {"cp": 0.85, "water_turbid": 0.15}),
    (13, 3, "noctiluca", {"noctiluca_green": 1.0}),
    (14, 3, "noctiluca", {"noctiluca_green": 0.85, "water_clear": 0.15}),
    (15, 3, "noctiluca", {"noctiluca_green": 0.75, "diatom": 0.25}),
    (16, 3, "noctiluca", {"noctiluca_green": 0.9, "water_turbid": 0.1}),
    (17, 4, "diatom", {"diatom": 1.0}),
    (18, 4, "diatom", {"diatom": 0.8, "water_clear": 0.2}),
    (19, 4, "diatom", {"diatom": 0.75, "noctiluca_green": 0.25}),
    (20, 5, "mixed", {"cp": 0.5, "noctiluca_green": 0.5}),
    (21, 5, "mixed", {"noctiluca_green": 0.5, "diatom": 0.5}),
    (22, 5, "mixed", {"cp": 0.5, "diatom": 0.5}),
    (23, 5, "mixed", {"cp": 0.4, "noctiluca_green": 0.3, "diatom": 0.3}),
    # Close blends: 24 is still named, 25 is too close to call. The mixed clusters
    # 20 and 23 are where the two comparisons disagree (shape diatom; pigment features
    # Noctiluca or C. polykrikoides), so they stay unclassified even where dense.
    (24, 4, "diatom", {"diatom": 0.7, "noctiluca_green": 0.3}),
    (25, 5, "mixed", {"noctiluca_green": 0.55, "diatom": 0.45}),
]

# Scenes: region, date, role, title, patches. Each patch is (kind, shape, args, peak chl).
#   kind: cp | noctiluca | diatom | mixed       a bloom (fluoresces; named if dense and clearly matched)
#         plume                                  muddy water: high chlorophyll reading, little fluorescence
#         turbid_bloom                           a dense bloom whose spectrum still looks like turbid water
#   shape: blob (cx, cy, sx, sy, theta) | swirl (cx, cy, r, arms, twist)
NASA_URL = "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/"
TEST_CONTEXT = ("Bloom in the Gulf of Oman documented by NASA Earth Observatory; PACE imaged it on 8 and 24 March 2025. "
                "Described as likely Noctiluca; species not confirmed by water sampling.")
# The final dates: 9 training (bloom) dates, 2 calm dates and 1 held-out test date.
SCENES = [
    ("gulf", "2024-10-11", "analysis_calm", "Oman coast: Normal calm water", []),
    ("gulf", "2024-10-30", "analysis_bloom", "Oman coast: Early season bloom, first year",
     [("diatom", "blob", (58.9, 24.3, 0.25, 0.12, 0.4), 16), ("cp", "blob", (58.35, 23.95, 0.12, 0.06, 0.2), 14)]),
    ("gulf", "2024-12-03", "analysis_bloom", "Oman coast: Strong bloom",
     [("cp", "blob", (58.55, 24.05, 0.28, 0.12, 0.3), 32), ("cp", "blob", (59.05, 24.45, 0.18, 0.1, -0.3), 22),
      ("mixed", "blob", (58.2, 24.35, 0.16, 0.08, 0.0), 14), ("plume", "blob", (57.55, 24.05, 0.16, 0.05, -0.45), 16),
      ("turbid_bloom", "blob", (57.95, 24.25, 0.1, 0.06, 0.0), 18)]),
    ("gulf", "2025-01-23", "analysis_bloom", "Oman coast: Mid-season bloom",
     [("noctiluca", "swirl", (58.8, 24.4, 0.45, 3, 6.0), 18), ("cp", "blob", (58.15, 23.85, 0.14, 0.07, 0.2), 16),
      ("plume", "blob", (57.2, 24.25, 0.14, 0.05, -0.45), 14)]),
    ("oman", "2025-03-24", "held_out_test", "Held-out test, 24 Mar 2025",
     [("noctiluca", "swirl", (58.75, 24.35, 0.6, 3, 7.0), 26), ("diatom", "blob", (59.2, 23.9, 0.15, 0.08, 0.5), 13)]),
    ("gulf", "2025-04-06", "analysis_bloom", "Oman coast: Late season bloom",
     [("diatom", "blob", (58.6, 24.6, 0.3, 0.14, 0.3), 15), ("noctiluca", "blob", (59.1, 24.1, 0.2, 0.1, -0.2), 12)]),
    ("gulf", "2024-12-09", "analysis_bloom", "UAE coast: Moderate bloom, 2024–25 season",
     [("cp", "blob", (55.25, 25.35, 0.18, 0.08, 0.6), 18), ("diatom", "blob", (54.6, 25.3, 0.22, 0.1, 0.2), 12)]),
    ("gulf", "2025-10-02", "analysis_bloom", "UAE coast: Early season bloom, second year",
     [("diatom", "blob", (55.0, 25.45, 0.25, 0.12, 0.4), 14)]),
    ("gulf", "2025-10-25", "analysis_calm", "UAE coast: Normal calm water", []),
    ("gulf", "2025-11-16", "analysis_bloom", "UAE coast: Mid-season bloom",
     [("cp", "blob", (55.35, 25.55, 0.2, 0.09, 0.5), 20), ("mixed", "blob", (54.85, 25.5, 0.14, 0.07, 0.0), 13)]),
    ("gulf", "2026-02-14", "analysis_bloom", "UAE coast: Strong bloom",
     [("cp", "blob", (55.2, 25.4, 0.3, 0.12, 0.6), 34), ("cp", "blob", (55.6, 25.6, 0.15, 0.08, 0.3), 24),
      ("noctiluca", "blob", (54.6, 25.45, 0.2, 0.1, 0.0), 15), ("turbid_bloom", "blob", (54.95, 25.75, 0.1, 0.05, 0.3), 16),
      ("plume", "blob", (56.6, 24.75, 0.12, 0.05, -0.6), 15)]),
    ("gulf", "2026-03-14", "analysis_bloom", "UAE coast: Late season bloom",
     [("cp", "blob", (55.45, 25.6, 0.16, 0.08, 0.4), 16), ("diatom", "blob", (54.9, 25.35, 0.2, 0.1, 0.2), 14)]),
]
BLOOM_KINDS = ("cp", "noctiluca", "diatom", "mixed", "turbid_bloom")

EXAMPLE_SITES = [
    ("gulf_desal_01", "Example desalination intake 1", "desalination", "gulf", 57.88, 23.73),
    ("gulf_desal_02", "Example desalination intake 2", "desalination", "gulf", 58.62, 23.64),
    ("gulf_aqua_01", "Example fish farm 1", "aquaculture", "gulf", 58.30, 23.70),
    ("gulf_beach_01", "Example public beach 1", "beach", "gulf", 58.45, 23.63),
    ("gulf_desal_03", "Example desalination intake 3", "desalination", "gulf", 55.03, 25.07),
    ("gulf_desal_04", "Example desalination intake 4", "desalination", "gulf", 54.70, 24.80),
    ("gulf_aqua_02", "Example fish farm 2", "aquaculture", "gulf", 55.58, 25.58),
    ("gulf_beach_02", "Example public beach 2", "beach", "gulf", 55.20, 25.21),
]


# --- field helpers -----------------------------------------------------------
def smooth_noise(shape, rng, passes=24):
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


def dilate(a):
    """One step of 4-neighbour growth, without wrapping around the edges."""
    out = a.copy()
    out[1:] |= a[:-1]
    out[:-1] |= a[1:]
    out[:, 1:] |= a[:, :-1]
    out[:, :-1] |= a[:, 1:]
    return out


def distance_to_land_km(land, max_km=150):
    """Rough distance from each water cell to the nearest land cell (inf beyond max_km)."""
    dist = np.where(land, 0.0, np.inf)
    cur = land.copy()
    for step in range(1, int(max_km / KM_PER_CELL) + 1):
        nxt = dilate(cur)
        dist[nxt & ~cur] = step * KM_PER_CELL
        cur = nxt
    return dist


def mixture(recipe, wl):
    return sum(weight * SHAPES[name](wl) for name, weight in recipe.items())


def ref_curve(ref):
    """A reference as references.json stores it (rounded), so every angle uses the stored curve."""
    return np.round(SHAPES[ref](REF_WL), 5)


# --- real depth sample (GEBCO 2020, via the public OpenTopoData API) ---------
def fetch_depth_sample(region="gulf"):
    """
    Sample GEBCO 2020 elevation at the centre of every 0.02 deg cell over the area that is
    water (or touches water), and save it to DEPTH_SAMPLE. The cells sit on a fixed lattice
    (edges at multiples of 0.02 deg), so when the area changes, the points an earlier sample
    already has are reused and only the rest are fetched. Uses the free OpenTopoData API:
    100 points per request, at most one request per second and 1,000 a day.
    """
    west, south, east, north = ec.REGIONS[region]["bbox"]
    r = DEPTH_SAMPLE_RES
    k0, k1 = math.floor(west / r + 1e-6), math.ceil(east / r - 1e-6)    # lattice columns k0 .. k1-1
    j0, j1 = math.floor(south / r + 1e-6), math.ceil(north / r - 1e-6)  # lattice rows j0 .. j1-1
    W, H = k1 - k0, j1 - j0
    lon = (k0 + np.arange(W) + 0.5) * r
    lat = (j1 - np.arange(H) - 0.5) * r                # row 0 = north
    LON, LAT = np.meshgrid(lon, lat)
    wanted = dilate(~globe.is_land(LAT, LON))          # water, plus a one-cell fringe of land
    elev = np.full((H, W), np.nan)
    reused = 0
    if os.path.exists(DEPTH_SAMPLE):
        with open(DEPTH_SAMPLE) as f:
            old = json.load(f)
        ow, _, _, on = old["bbox"]
        for n, v in enumerate(old["elevation_m"]):
            if v is None:
                continue
            row, col = divmod(n, old["width"])
            i = (j1 * r - (on - (row + 0.5) * r)) / r - 0.5
            j = (ow + (col + 0.5) * r - k0 * r) / r - 0.5
            if abs(i - round(i)) < 1e-4 and abs(j - round(j)) < 1e-4 and 0 <= round(i) < H and 0 <= round(j) < W:
                elev[round(i), round(j)] = v
                reused += 1
    idx = np.argwhere(wanted & ~np.isfinite(elev))
    print(f"reusing {reused} points from the earlier sample")
    print(f"sampling GEBCO 2020 at {len(idx)} points ({(len(idx) + 99) // 100} requests, about one per second)")
    for start in range(0, len(idx), 100):
        batch = idx[start:start + 100]
        locs = "|".join(f"{LAT[i, j]:.4f},{LON[i, j]:.4f}" for i, j in batch)
        url = f"https://api.opentopodata.org/v1/gebco2020?locations={locs}"
        for attempt in range(6):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "gulf-bloom-watch mock data"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    results = json.load(resp)["results"]
                break
            except Exception as err:  # rate limit or a hiccup: wait and retry
                print(f"  retry after: {err}")
                time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError("OpenTopoData kept failing; try again later")
        for (i, j), res in zip(batch, results):
            if res.get("elevation") is not None:
                elev[i, j] = res["elevation"]
        time.sleep(1.05)
    obj = {
        "source": "GEBCO 2020 grid, sampled at 0.02 deg cell centres through api.opentopodata.org",
        "credit": "GEBCO Compilation Group (2020) GEBCO 2020 Grid",
        "bbox": [round(k0 * r, 2), round(j0 * r, 2), round(k1 * r, 2), round(j1 * r, 2)], "res_deg": [r, r], "width": W, "height": H,
        "rows": "row 0 is the northernmost row",
        "elevation_m": [None if not np.isfinite(v) else int(v) for v in elev.ravel()],
    }
    with open(DEPTH_SAMPLE, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"wrote {DEPTH_SAMPLE}")


def depth_from_sample(lon, lat, land):
    """Depth (positive metres) on the mock grid, interpolated from the GEBCO sample; None without it."""
    if not os.path.exists(DEPTH_SAMPLE):
        return None
    with open(DEPTH_SAMPLE) as f:
        s = json.load(f)
    sw, ss, se, sn = s["bbox"]
    if lon[0] < sw or lon[-1] > se or lat.min() < ss or lat.max() > sn:
        print("note: the GEBCO sample doesn't cover the whole area. Run with --fetch-depth to extend it.")
        return None
    west, north = sw, sn
    r = s["res_deg"][0]
    depth = -np.array([np.nan if v is None else v for v in s["elevation_m"]], dtype=float).reshape(s["height"], s["width"])
    # Fill unsampled (inland) cells from their neighbours, so interpolation near the coast has values.
    for _ in range(4):
        miss = ~np.isfinite(depth)
        if not miss.any():
            break
        pad = np.pad(depth, 1, constant_values=np.nan)
        neigh = np.stack([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]])
        ok = np.isfinite(neigh)
        count, total = ok.sum(axis=0), np.where(ok, neigh, 0).sum(axis=0)
        fill = miss & (count > 0)
        depth[fill] = total[fill] / count[fill]
    depth = np.where(np.isfinite(depth), depth, 0.0)
    # Bilinear interpolation onto the mock grid's cell centres.
    LON, LAT = np.meshgrid(lon, lat)
    x = np.clip((LON - west) / r - 0.5, 0, s["width"] - 1.001)
    y = np.clip((north - LAT) / r - 0.5, 0, s["height"] - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    d = (depth[y0, x0] * (1 - fx) * (1 - fy) + depth[y0, x0 + 1] * fx * (1 - fy)
         + depth[y0 + 1, x0] * (1 - fx) * fy + depth[y0 + 1, x0 + 1] * fx * fy)
    d = np.maximum(d, 1.0)  # water the coarse sample calls land is still water here: very shallow
    d[land] = np.nan
    return d


# --- the shared grid: land, depth --------------------------------------------
def make_static(region, seed=99):
    west, south, east, north = ec.REGIONS[region]["bbox"]
    W, H = round((east - west) / RES), round((north - south) / RES)
    lon = west + (np.arange(W) + 0.5) * RES
    lat = south + (np.arange(H) + 0.5) * RES          # south -> north, like xarray
    LON, LAT = np.meshgrid(lon, lat)
    land = globe.is_land(LAT, LON)
    dist = distance_to_land_km(land)
    d = np.where(np.isfinite(dist), dist, 150.0)

    depth = depth_from_sample(lon, lat, land)
    if depth is not None:
        source = "MOCK stand-in: GEBCO 2020 sampled every 0.02 deg (OpenTopoData), interpolated to 0.01 deg"
    else:
        # Invented bathymetry: a gentle shelf on the Gulf side, a steep drop in the Sea of Oman.
        print("note: no GEBCO sample; depth is invented. Run with --fetch-depth once for real depths.")
        rng = np.random.default_rng(seed)
        depth = np.where(LON < 56.4, np.minimum(2 + 1.6 * d, 90), np.minimum(4 + 6 * d + 0.6 * d ** 2, 3200))
        depth = depth * (1 + 0.12 * smooth_noise(LON.shape, rng))
        depth[land] = np.nan
        source = "MOCK: invented depth from the distance to land, not GEBCO"
    return {"lon": lon, "lat": lat, "LON": LON, "LAT": LAT, "land": land, "dist": d, "depth": depth,
            "shallow": ec.shallow_mask(depth), "depth_source": source}


# --- clusters ----------------------------------------------------------------
def build_clusters():
    clusters, by_kind = [], {}
    gaps = ec.reference_gaps({ref: (REF_WL, ref_curve(ref)) for ref in ec.REFERENCES})
    for cid, parent, kind, recipe in CLUSTER_RECIPES:
        mean = mixture(recipe, PACE_WL)
        angles = {ref: ec.spectral_angle_deg(mean, ref_curve(ref), PACE_WL, REF_WL) for ref in ec.REFERENCES}
        deriv = {ref: ec.spectral_angle_deriv_deg(mean, ref_curve(ref), PACE_WL, REF_WL) for ref in ec.REFERENCES}
        rec = ec.cluster_record(cid, mean, angles, n_pixels=0, parent_id=parent, sam_deriv_deg=deriv, ref_gaps=gaps)
        clusters.append(rec)
        by_kind.setdefault(kind, []).append(cid)
    return clusters, by_kind


# --- one scene ---------------------------------------------------------------
def make_scene(region, date, role, title, patches, clusters, by_kind, st, seed):
    scene_id = f"{region}_pace_{date.replace('-', '')}"
    west, south, east, north = ec.REGIONS[region]["bbox"]
    LON, LAT, land, shallow, dist = st["LON"], st["LAT"], st["land"], st["shallow"], st["dist"]
    rng = np.random.default_rng(seed)

    coast = (dist <= 6) & ~land
    # Background: offshore clear water, turbid near the coast. Chlorophyll ~0.2-3 mg m^-3.
    chl = np.exp(np.log(0.6) + 0.6 * smooth_noise(LON.shape, rng) + 0.9 * coast)
    kind = np.where(coast, "turbid", "clear").astype(object)
    # In the flagged 5-15 m zone the seabed can still tint the water and raise the
    # chlorophyll reading a little; it doesn't glow, so the clusters call it seabed.
    tinted = ec.shallow_flag(st["depth"]) & (LON < 56.4)
    kind[tinted] = "seabed"
    chl = np.where(tinted, chl * np.exp(0.5 + 0.3 * smooth_noise(LON.shape, rng)), chl)
    # Low fluorescence everywhere except blooms (W m^-2 um^-1 sr^-1).
    nflh = 0.02 + 0.01 * chl
    # In shallow water the seabed and stirred-up sediment raise the chlorophyll reading,
    # which is why it is masked instead of named. The value is still stored and shown.
    chl = np.where(shallow, chl * np.exp(1.2 + 0.5 * smooth_noise(LON.shape, rng)), chl)
    nflh = np.where(shallow, 0.06 + 0.012 * chl, nflh)

    weak_glow = smooth_noise(LON.shape, rng) < -1.0  # patches of blooms with little fluorescence
    for pkind, shape, args, peak in patches:
        f = (swirl if shape == "swirl" else blob)(LON, LAT, *args)
        f = np.clip(f * (1 + 0.25 * smooth_noise(LON.shape, rng)), 0, 1)
        patch_chl = peak * f
        inside = (f > 0.18) & (patch_chl > chl) & ~shallow
        chl = np.where(inside, np.maximum(chl, patch_chl), chl)
        if pkind == "plume":
            kind[inside] = "turbid"
            nflh = np.where(inside, 0.03 + 0.003 * chl, nflh)
            continue
        kind[inside] = "turbid" if pkind == "turbid_bloom" else pkind
        glow = 0.024 * chl * (1 + 0.12 * smooth_noise(LON.shape, rng))
        nflh = np.where(inside, np.where(weak_glow, 0.35, 1.0) * glow, nflh)
        # a ring of mixed spectra at the edge of named blooms
        if pkind in ("cp", "noctiluca", "diatom"):
            edge = (f > 0.1) & (f <= 0.18) & ~shallow
            kind[edge] = "mixed"
            chl = np.where(edge, np.maximum(chl, 0.6 * peak * f + 4), chl)
            nflh = np.where(edge, 0.024 * chl, nflh)

    cluster_id = np.full(LON.shape, np.nan)
    for k, ids in by_kind.items():
        m = kind == k
        cluster_id[m] = rng.choice(ids, size=int(m.sum()))

    cloud = np.zeros_like(land)
    for cx, cy, sx, sy in [(rng.uniform(west, east), rng.uniform(south, north), 0.25, 0.15) for _ in range(2)]:
        cloud |= (blob(LON, LAT, cx, cy, sx, sy) * (1 + 0.5 * smooth_noise(LON.shape, rng))) > 0.6
    chl[land | cloud] = np.nan
    nflh[land | cloud] = np.nan

    code = ec.classify(chl, cluster_id, clusters, land, cloud, shallow, nflh=nflh)

    by_id = {c["cluster_id"]: c for c in clusters}
    cube = np.full(LON.shape + (len(PACE_WL),), np.nan, dtype=np.float32)
    for cid in np.unique(cluster_id[np.isfinite(cluster_id)]).astype(int):
        m = (cluster_id == cid) & (code >= 3)
        n = int(m.sum())
        noise = 1 + 0.04 * rng.standard_normal((n, len(PACE_WL)), dtype=np.float32)
        cube[m] = np.array(by_id[cid]["mean_rrs"], dtype=np.float32) * noise
        by_id[cid]["n_pixels"] += n if role != "held_out_test" else 0

    bbox, resd, (code, chl, nflh, cluster_id, cube) = ec.orient_grid(
        st["lat"], st["lon"], code, chl, nflh, cluster_id, cube)
    ec.write_grid(DATA_DIR, scene_id, bbox, resd, code, chl, cluster_id, clusters, nflh=nflh)
    probes, means = ec.pick_probes(bbox, resd, code, chl, cube, per_class=5, seed=seed)
    ec.write_spectra(DATA_DIR, scene_id, PACE_WL, probes, means)

    meta = {"scene_id": scene_id, "role": role, "status": "mock", "title": title,
            "products": ["PACE_OCI_L2_AOP", "PACE_OCI_L2_BGC", "PACE_OCI_L2_IOP"]}
    if role == "held_out_test":
        meta.update(context=TEST_CONTEXT, source_url=NASA_URL)
    elif role == "analysis_calm":
        meta["context"] = "Calm-water date pooled into the k-means fit so it learns normal water."
    else:
        meta["context"] = "Bloom date pooled into the k-means fit; water-type references are also taken from it."
    ec.update_manifest(DATA_DIR, meta)
    return scene_id


# --- housekeeping ------------------------------------------------------------
def clear_mock_scenes():
    """Remove mock scenes (manifest entries and folders) so the mock set is regenerated cleanly.
    Real scenes are never touched."""
    if os.path.exists(os.path.join(DATA_DIR, "depth.json")):  # the single depth file of the old layout
        os.remove(os.path.join(DATA_DIR, "depth.json"))
    path = os.path.join(DATA_DIR, "manifest.json")
    keep = []
    if os.path.exists(path):
        with open(path) as f:
            scenes = json.load(f).get("scenes", [])
        keep = [s for s in scenes if s.get("status") == "real" and ec.SCENE_ID_RE.match(s.get("scene_id", ""))]
        for s in scenes:
            if s.get("status") == "mock":
                shutil.rmtree(os.path.join(DATA_DIR, "scenes", s.get("scene_id", "")), ignore_errors=True)
    ec.write_manifest(DATA_DIR, keep)


def write_example_sites():
    """Copy the real sites from data/sites.geojson, or write example sites when there are none."""
    path = os.path.join(DATA_DIR, "sites.geojson")
    real = os.path.join(REAL_DATA_DIR, "sites.geojson")
    if os.path.abspath(real) != os.path.abspath(path) and os.path.exists(real):
        shutil.copyfile(real, path)
        print(f"copied {real} to {path}")
        return
    if os.path.exists(path):
        with open(path) as f:
            names = [ft.get("properties", {}).get("name", "") for ft in json.load(f).get("features", [])]
        if names and not all(n.startswith("Example ") for n in names):
            print(f"kept existing {path} (it has real sites)")
            return
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
         "properties": {"site_id": sid, "name": name, "type": t, "region": r}}
        for sid, name, t, r, lon, lat in EXAMPLE_SITES]}
    with open(path, "w") as f:
        json.dump(fc, f, indent=1)
    print(f"wrote {path} (example sites: replace with real ones)")


def main():
    global DATA_DIR
    if "--out" in sys.argv:
        DATA_DIR = os.path.abspath(sys.argv[sys.argv.index("--out") + 1])
    if os.path.abspath(DATA_DIR) == os.path.abspath(REAL_DATA_DIR):
        sys.exit("make_mock_data.py doesn't write into data/: that folder holds the real data.")
    if "--fetch-depth" in sys.argv:
        fetch_depth_sample()
    os.makedirs(os.path.join(DATA_DIR, "scenes"), exist_ok=True)

    statics = {}
    for region in dict.fromkeys(r for r, *_ in SCENES):
        statics[region] = st = make_static(region)
        bbox, resd, (depth,) = ec.orient_grid(st["lat"], st["lon"], st["depth"])
        ec.write_depth(DATA_DIR, region, bbox, resd, depth, source=st["depth_source"])
    clear_mock_scenes()

    ec.write_references(DATA_DIR, [{
        "ref_id": ref,
        "label": REFERENCE_INFO[ref][0],
        "source": REFERENCE_INFO[ref][1],
        "source_url": None,
        "wavelengths_nm": REF_WL.tolist(),
        "rrs": ref_curve(ref).tolist(),
        "notes": "Invented shape for building the interface. Not a measurement.",
    } for ref in ec.REFERENCES])

    clusters, by_kind = build_clusters()
    for i, (region, date, role, title, patches) in enumerate(SCENES):
        make_scene(region, date, role, title, patches, clusters, by_kind, statics[region], seed=i + 1)

    fit_dates = [d for _, d, role, _, _ in SCENES if role != "held_out_test"]
    ec.write_clusters(DATA_DIR, PACE_WL, clusters, {
        "dates": fit_dates,
        "k_coarse": len({c["parent_id"] for c in clusters}),
        "k_fine": len(clusters),
        "pca_components": 8,
        "notes": "MOCK: invented clusters for building the interface.",
    })
    write_example_sites()


if __name__ == "__main__":
    main()

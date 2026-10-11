"""
export_contract.py: write pipeline outputs in the exact format of docs/DATA_CONTRACT.md.

Use these functions instead of writing JSON by hand, so that names, grid
orientation, class codes and units can't drift between the pipeline and the
dashboard.

Requires: numpy (nothing else).

Typical use (see export_scene_example() at the bottom):

    # once, after fitting k-means on the pooled analysis dates: two comparisons per cluster,
    # shape (SAM on the curves) and pigment features (SAM on their second derivatives)
    gaps = reference_gaps({ref_id: (ref_wl, ref_rrs) for ...})
    angles = {ref_id: spectral_angle_deg(cluster_mean, ref_rrs, wavelengths, ref_wl) for ...}
    deriv = {ref_id: spectral_angle_deriv_deg(cluster_mean, ref_rrs, wavelengths, ref_wl) for ...}
    clusters = [cluster_record(cid, mean_rrs, angles, n_pixels, parent_id, sam_deriv_deg=deriv, ref_gaps=gaps) for ...]
    write_references(DATA_DIR, references)
    write_clusters(DATA_DIR, wavelengths, clusters, fit_info)

    # once per area: GEBCO depth resampled to the same 0.01 deg cells as its scenes
    bbox, res, (depth,) = orient_grid(lat, lon, depth)
    write_depth(DATA_DIR, "gulf", bbox, res, depth, source="GEBCO, resampled to the 0.01 deg grid")

    # per scene
    shallow = shallow_mask(depth)
    code = classify(chlor_a, cluster_id, clusters, land, no_data, shallow, nflh=nflh)
    bbox, res, (code, chlor_a, nflh, cluster_id, rrs) = orient_grid(lat, lon, code, chlor_a, nflh, cluster_id, rrs)
    write_grid(DATA_DIR, scene_id, bbox, res, code, chlor_a, cluster_id, clusters, nflh=nflh)
    probes, means = pick_probes(bbox, res, code, chlor_a, rrs)
    write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)
    update_manifest(DATA_DIR, {...scene info...})
"""

import datetime
import json
import os
import re

import numpy as np

CONTRACT_VERSION = "1.0"

# ---------------------------------------------------------------------------
# The ONLY place the thresholds are defined. update_manifest() copies this
# block into data/manifest.json, and the dashboard reads it from there.
# ---------------------------------------------------------------------------
RULE = {
    "name": "Chlorophyll and fluorescence density gate, then k-means clusters named by two spectral-angle (SAM) comparisons and the SAM margin",
    "chl_product": "PACE_OCI_L2_BGC chlor_a",
    "chl_units": "mg m^-3",
    "chl_weak_min": 5.0,    # chlorophyll below this: no bloom
    "chl_dense_min": 10.0,  # at or above this (with raised nflh): dense enough to name a species
    "nflh_product": "PACE_OCI_L2_AOP nflh",
    "nflh_units": "W m^-2 um^-1 sr^-1",
    "nflh_dense_min": 0.2479,  # the data team's threshold: fluorescence counts as raised at this or more; needed for "dense"
    "margin_min": 0.25,     # SAM margin below this: too close to call, stays unclassified
    "margin_formula": "(angle to second-best reference - angle to best reference) / angle between those two references, clipped to 0-1",
    "confidence_bands": [
        {"key": "low", "label": "Low", "min": 0.25},
        {"key": "medium", "label": "Medium", "min": 0.5},
        {"key": "high", "label": "High", "min": 0.75},
    ],
    # The shape comparison (SAM on the curves) uses these bands only: below 500 nm the
    # atmospheric correction over-corrects dense blooms, often to negative values.
    "sam_range_nm": [500.0, 700.0],
    # The second comparison: SAM on the smoothed second derivative of the curves, which
    # flattens broad backgrounds (a sediment slope, an offset) and keeps narrow pigment
    # dips and bumps. Both comparisons must pick the same reference to name a species.
    "deriv_filter": "Savitzky-Golay",
    "deriv_range_nm": [430.0, 700.0],  # the bands the pigment-feature comparison uses
    "deriv_window": 11,                # bands in each smoothing window (PACE's own bands, not resampled)
    "deriv_polyorder": 2,              # degree of the curve fitted in each window
    "shallow_max_m": 5.0,        # water shallower than this is not assessed (code 1)
    "shallow_flag_max_m": 15.0,  # assessed water from shallow_max_m to this deep is flagged: the seabed may show
}

# Lowest concern first. "Not assessed" is for cells that were never tested.
RISK_TIERS = [
    {"key": "not_assessed", "label": "Not assessed", "rank": 0},
    {"key": "none", "label": "No flag", "rank": 1},
    {"key": "low", "label": "Low", "rank": 2},
    {"key": "monitor", "label": "Monitor", "rank": 3},
    {"key": "watch", "label": "Watch", "rank": 4},
    {"key": "high", "label": "High", "rank": 5},
]

# In precedence order: each pixel takes the first class that applies (classify()).
CLASSES = [
    {"code": 0, "key": "land", "label": "Land", "risk_tier": "not_assessed"},
    {"code": 1, "key": "shallow", "label": "Shallow water, not assessed", "risk_tier": "not_assessed"},
    {"code": 2, "key": "no_data", "label": "No data", "risk_tier": "not_assessed"},
    {"code": 3, "key": "clear", "label": "Non-bloom water", "risk_tier": "none"},
    {"code": 4, "key": "weak_unclassified", "label": "Weak bloom, unclassified", "risk_tier": "monitor"},
    {"code": 5, "key": "dense_unclassified", "label": "Dense bloom, unclassified", "risk_tier": "watch"},
    {"code": 6, "key": "cp_like", "label": "C. polykrikoides-like bloom", "risk_tier": "high"},
    {"code": 7, "key": "noctiluca_like", "label": "Green Noctiluca-like bloom", "risk_tier": "monitor"},
    {"code": 8, "key": "diatom_like", "label": "Diatom-like bloom", "risk_tier": "low"},
]
CODE = {c["key"]: c["code"] for c in CLASSES}

# Reference spectra the clusters are compared against. A bloom reference names
# a class; a water reference means "not a bloom".
REFERENCES = {
    "cp": {"group": "bloom", "class_key": "cp_like"},
    "noctiluca_green": {"group": "bloom", "class_key": "noctiluca_like"},
    "diatom": {"group": "bloom", "class_key": "diatom_like"},
    "water_clear": {"group": "water", "class_key": "clear"},
    "water_turbid": {"group": "water", "class_key": "clear"},
    "seabed": {"group": "water", "class_key": "clear"},
}
# label_key of a cluster: a bloom class key, "water", or "unclassified".
CLUSTER_LABELS = ("cp_like", "noctiluca_like", "diatom_like", "water", "unclassified")

# Each area has its own box and its own depth file (depth_<region>.json).
REGIONS = {
    "gulf": {"label": "UAE and Oman coasts, Arabian Gulf to Sea of Oman", "bbox": [51.2, 21.8, 60.79, 27.03]},
    "oman": {"label": "Sea of Oman and Oman's Arabian Sea coast", "bbox": [56.0, 19.0, 63.0, 26.5]},
}
SENSORS = ("pace",)
ROLES = ("analysis_bloom", "analysis_calm", "held_out_test")
STATUSES = ("mock", "real")
SCENE_ID_RE = re.compile(r"^(" + "|".join(REGIONS) + r")_(pace)_(\d{8})$")
# Units of the cluster and reference curves: Rrs itself, or curves scaled to unit length
# (SAM only compares shape, so either works).
SPECTRUM_UNITS = ("sr^-1", "normalized")

# Decimals used when writing. classify() compares the ROUNDED values, so the
# class always agrees with the number the dashboard shows.
DECIMALS = {"chlor_a": 2, "nflh": 4, "depth_m": 0, "sam_deg": 2, "margin": 2, "rrs": 5}

MAX_CELLS = 600_000
MAX_GRID_MB = 15.0
MAX_SPECTRA_MB = 1.0
MAX_CLUSTERS_MB = 2.0


# ---------------------------------------------------------------------------
# 1. Spectral angle and cluster naming
# ---------------------------------------------------------------------------
def resample(src_wl, src_rrs, target_wl):
    """Linear interpolation of a spectrum onto target_wl; NaN outside the source range."""
    src_wl = np.asarray(src_wl, dtype=float)
    src = np.asarray(src_rrs, dtype=float)
    ok = np.isfinite(src)
    t = np.asarray(target_wl, dtype=float)
    out = np.interp(t, src_wl[ok], src[ok])
    out[(t < src_wl[ok].min()) | (t > src_wl[ok].max())] = np.nan
    return out


def spectral_angle_deg(a, b, wl_a=None, wl_b=None, rule=RULE):
    """
    The shape comparison: the spectral angle between two spectra, in degrees (0 = identical
    shape). If wavelengths are given, b is resampled onto a's wavelengths first and only
    bands within RULE["sam_range_nm"] are compared. Only bands where both are finite are used.
    """
    a = np.asarray(a, dtype=float)
    b = resample(wl_b, b, wl_a) if wl_a is not None and wl_b is not None else np.asarray(b, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    if wl_a is not None:
        lo, hi = rule["sam_range_nm"]
        w = np.asarray(wl_a, dtype=float)
        ok &= (w >= lo) & (w <= hi)
    if ok.sum() < 3:
        raise ValueError("fewer than 3 shared bands between the two spectra")
    a, b = a[ok], b[ok]
    cos = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def second_derivative(wl, rrs, rule=RULE):
    """
    The smoothed second derivative of a spectrum (Savitzky-Golay), on its own bands.

    Over RULE["deriv_range_nm"], each band gets the second derivative of a
    degree-RULE["deriv_polyorder"] curve fitted by least squares through
    RULE["deriv_window"] neighbouring bands, counted by band (PACE's bands are close to
    evenly spaced). Smoothing first matters: a plain second derivative is mostly noise.
    Bands whose window runs past either end, or over a missing value, are NaN.

    Returns (wl_nm, d2), both 1-D, for the bands in the range.
    """
    lo, hi = rule["deriv_range_nm"]
    w = np.asarray(wl, dtype=float)
    keep = (w >= lo) & (w <= hi)
    t, y = w[keep], np.asarray(rrs, dtype=float)[keep]
    window, order = int(rule["deriv_window"]), int(rule["deriv_polyorder"])
    if window % 2 == 0 or window <= order or order < 2:
        raise ValueError("deriv_window must be odd and larger than deriv_polyorder, which must be at least 2")
    half = window // 2
    x = np.arange(-half, half + 1, dtype=float)
    coeffs = np.linalg.pinv(np.vander(x, order + 1, increasing=True))[2] * 2.0  # d2/dx2 at the centre

    d2 = np.full(t.shape, np.nan)
    for i in range(half, len(t) - half):
        win = y[i - half:i + half + 1]
        if np.all(np.isfinite(win)):
            d2[i] = float(np.dot(coeffs, win))
    return t, d2


def spectral_angle_deriv_deg(a, b, wl_a, wl_b, rule=RULE):
    """
    The pigment-feature comparison: the spectral angle between the smoothed second
    derivatives of two spectra, in degrees (0 = identical; up to 180, since derivatives
    change sign). b is resampled onto a's wavelengths first, so both derivatives use the
    same bands; the edge points of either one are left out.
    """
    b = resample(wl_b, b, wl_a)
    _, da = second_derivative(wl_a, a, rule)
    _, db = second_derivative(wl_a, b, rule)
    ok = np.isfinite(da) & np.isfinite(db)
    if ok.sum() < 3:
        raise ValueError("fewer than 3 shared points between the two derivatives")
    da, db = da[ok], db[ok]
    cos = np.dot(da, db) / (np.linalg.norm(da) * np.linalg.norm(db))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def reference_gaps(references, rule=RULE):
    """
    The shape angle between every two references: how different they are from each other.
    references: dict ref_id -> (wavelengths_nm, rrs). Returns {(a, b): degrees} for every
    ordered pair; the margin of a cluster is measured against the gap of its two best matches.
    """
    return {(a, b): spectral_angle_deg(ra, rb, wa, wb, rule)
            for a, (wa, ra) in references.items() for b, (wb, rb) in references.items() if a != b}


def cluster_record(cluster_id, mean_rrs, sam_deg, n_pixels, parent_id=None, rule=RULE, *, sam_deriv_deg, ref_gaps):
    """
    One entry of clusters.json, named from its angles to the references.

    sam_deg        dict ref_id -> angle in degrees, for every reference in REFERENCES: the
                   shape comparison (SAM on the curves). The margin, and so the confidence,
                   come from these.
    sam_deriv_deg  dict ref_id -> angle in degrees, for every reference: the pigment-feature
                   comparison (SAM on the smoothed second derivatives, spectral_angle_deriv_deg()).
    ref_gaps       reference_gaps(): the angle between every two references.
    A species is named only when both comparisons pick the same reference.
    margin = (angle to second-best - angle to best) / angle between those two references,
    clipped to 0-1: how clearly the best reference beat the runner-up, measured against how
    different the two references are. It is computed from the unrounded angles.
    """
    for name, given in (("sam_deg", sam_deg), ("sam_deriv_deg", sam_deriv_deg)):
        missing = set(REFERENCES) - set(given)
        if missing:
            raise ValueError(f"cluster {cluster_id}: {name} is missing angles for {sorted(missing)}")
    raw = {r: float(sam_deg[r]) for r in REFERENCES}
    angles = {r: round(raw[r], DECIMALS["sam_deg"]) for r in REFERENCES}
    deriv = {r: round(float(sam_deriv_deg[r]), DECIMALS["sam_deg"]) for r in REFERENCES}
    ranked = sorted(angles, key=lambda r: (angles[r], raw[r], r))
    best, second = ranked[0], ranked[1]
    best_deriv = min(deriv, key=lambda r: (deriv[r], r))
    gap = float(ref_gaps[(best, second)])
    margin = 0.0 if gap <= 0 else min(1.0, max(0.0, (raw[second] - raw[best]) / gap))
    margin = round(margin, DECIMALS["margin"])

    if REFERENCES[best]["group"] == "water":
        label = "water"
    elif margin < rule["margin_min"] or best_deriv != best:
        label = "unclassified"
    else:
        label = REFERENCES[best]["class_key"]
    return {
        "cluster_id": int(cluster_id),
        "parent_id": None if parent_id is None else int(parent_id),
        "n_pixels": int(n_pixels),
        "mean_rrs": _flat_list(mean_rrs, DECIMALS["rrs"]),
        "sam_deg": angles,
        "best_ref": best,
        "second_ref": second,
        "ref_gap_deg": round(gap, DECIMALS["sam_deg"]),
        "margin": margin,
        "sam_deriv_deg": deriv,
        "best_ref_deriv": best_deriv,
        "label_key": label,
    }


# ---------------------------------------------------------------------------
# 2. Classification
# ---------------------------------------------------------------------------
def _cluster_lookup(cluster_id, clusters):
    """Per-pixel best-ref group, margin, agreement of the two comparisons and species from the cluster table."""
    by_id = {c["cluster_id"]: c for c in clusters}
    cid = np.asarray(cluster_id, dtype=float)
    valid = np.isfinite(cid)
    ids = np.where(valid, cid, -1).astype(int)
    unknown = set(np.unique(ids[valid]).tolist()) - set(by_id)
    if unknown:
        raise ValueError(f"cluster_id values not in the cluster table: {sorted(unknown)[:10]}")
    water = np.zeros(cid.shape, dtype=bool)
    margin = np.full(cid.shape, np.nan)
    agree = np.zeros(cid.shape, dtype=bool)
    best_class = np.full(cid.shape, -1, dtype=int)
    for k, c in by_id.items():
        m = ids == k
        water[m] = REFERENCES[c["best_ref"]]["group"] == "water"
        margin[m] = c["margin"]
        agree[m] = c.get("best_ref_deriv") == c["best_ref"]
        best_class[m] = CODE.get(REFERENCES[c["best_ref"]]["class_key"], -1)
    return valid, water, margin, agree, best_class


def _water_codes(chl, nflh, water, margin, agree, best_class, rule):
    """Codes 3-8 for pixels that passed the masks, from rounded chl and nflh."""
    with np.errstate(invalid="ignore"):
        dense = (chl >= rule["chl_dense_min"]) & (nflh >= rule["nflh_dense_min"])
        code = best_class.copy()
        code[water | (margin < rule["margin_min"]) | ~agree] = CODE["dense_unclassified"]
        code[~dense] = np.where(water, CODE["clear"], CODE["weak_unclassified"])[~dense]
        code[chl < rule["chl_weak_min"]] = CODE["clear"]
    return code


def classify(chlor_a, cluster_id, clusters, land, no_data, shallow, *, nflh, rule=RULE):
    """
    Class code for every pixel. All inputs have the same 2-D shape.

    chlor_a      chlorophyll-a in mg m^-3 (NaN where missing)
    cluster_id   k-means cluster of each pixel (NaN where not clustered)
    clusters     the list of cluster_record() entries
    land, no_data, shallow: boolean masks (True = masked); shallow = shallow_mask(depth)
    nflh         normalized fluorescence line height in RULE["nflh_units"] (NaN where missing)

    Precedence (first match wins):
      land
      shallow             shallower than shallow_max_m, whatever the quality flags say
      no data             failed quality flags, or no chlorophyll or no cluster
      clear               chl below chl_weak_min
      (dense = chl >= chl_dense_min AND nflh >= nflh_dense_min; a missing nflh is not raised)
      clear               not dense, and the cluster's best match is a water reference
      weak bloom          not dense
      dense unclassified  the best match is a water reference, the margin is below margin_min,
                          or the two comparisons (shape and pigment features) disagree
      otherwise the species of the best-matching reference
    """
    chl = np.round(np.asarray(chlor_a, dtype=float), DECIMALS["chlor_a"])
    fl = np.round(np.asarray(nflh, dtype=float), DECIMALS["nflh"])
    if fl.shape != chl.shape:
        raise ValueError(f"nflh shape {fl.shape} != chlor_a shape {chl.shape}")
    valid, water, margin, agree, best_class = _cluster_lookup(cluster_id, clusters)

    # Later assignments win, so the masks go in reverse precedence.
    code = _water_codes(chl, fl, water, margin, agree, best_class, rule)
    code[np.asarray(no_data, dtype=bool) | ~np.isfinite(chl) | ~valid] = CODE["no_data"]
    code[np.asarray(shallow, dtype=bool)] = CODE["shallow"]
    code[np.asarray(land, dtype=bool)] = CODE["land"]
    return code.astype(np.int8)


# ---------------------------------------------------------------------------
# 3. Grid orientation
# ---------------------------------------------------------------------------
def orient_grid(lat, lon, *arrays):
    """
    Put arrays into contract orientation: row 0 = north, column 0 = west.

    lat, lon   1-D arrays of CELL-CENTER coordinates, in any order
    *arrays    arrays shaped (len(lat), len(lon), ...), e.g. 2-D fields or a 3-D Rrs cube

    Returns bbox [west, south, east, north] (outer edges), res [res_lon, res_lat],
    and the arrays flipped as needed (None passes through unchanged).
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    for name, c in (("lat", lat), ("lon", lon)):
        d = np.diff(c)
        if len(c) < 2 or not np.allclose(d, d[0], rtol=1e-3, atol=1e-9):
            raise ValueError(f"{name} is not regularly spaced. Grid the Level-2 swath onto a regular lat/lon grid first.")

    flip_rows = lat[0] < lat[-1]   # south -> north: flip so row 0 is north
    flip_cols = lon[0] > lon[-1]   # east -> west: flip so col 0 is west
    if flip_rows:
        lat = lat[::-1]
    if flip_cols:
        lon = lon[::-1]

    out = []
    for a in arrays:
        if a is None:
            out.append(None)
            continue
        a = np.asarray(a)
        if a.shape[0] != len(lat) or a.shape[1] != len(lon):
            raise ValueError(f"array shape {a.shape} doesn't match (lat={len(lat)}, lon={len(lon)})")
        if flip_rows:
            a = a[::-1, ...]
        if flip_cols:
            a = a[:, ::-1, ...]
        out.append(np.ascontiguousarray(a))

    res_lat = abs(lat[1] - lat[0])
    res_lon = abs(lon[1] - lon[0])
    bbox = [lon[0] - res_lon / 2, lat[-1] - res_lat / 2, lon[-1] + res_lon / 2, lat[0] + res_lat / 2]
    return [round(v, 6) for v in bbox], [round(res_lon, 8), round(res_lat, 8)], out


# ---------------------------------------------------------------------------
# 4. Writers
# ---------------------------------------------------------------------------
def _flat_list(a, decimals):
    """Flatten row-major, round, and turn NaN into None (JSON null)."""
    a = np.asarray(a, dtype=float).ravel(order="C")
    vals = np.round(a, decimals).astype(object)
    vals[~np.isfinite(a)] = None
    return vals.tolist()


def _int_list(a):
    """Flatten row-major integers, NaN/negative -> None."""
    a = np.asarray(a, dtype=float).ravel(order="C")
    return [None if not np.isfinite(v) or v < 0 else int(v) for v in a]


def _check_scene_id(scene_id):
    if not SCENE_ID_RE.match(scene_id):
        raise ValueError(f"scene_id '{scene_id}' must look like gulf_pace_20250324 (region_sensor_YYYYMMDD)")


def _check_consistency(code, chlor_a, nflh, cluster_id, clusters, rule=RULE):
    """Raise if class codes don't follow from chlorophyll, nflh and the cluster table."""
    chl = np.round(np.asarray(chlor_a, dtype=float), DECIMALS["chlor_a"])
    fl = np.round(np.asarray(nflh, dtype=float), DECIMALS["nflh"])
    valid, water, margin, agree, best_class = _cluster_lookup(cluster_id, clusters)
    problems = []
    named = np.isin(code, [3, 4, 5, 6, 7, 8])
    if np.any(named & ~(np.isfinite(chl) & valid)):
        problems.append("codes 3-8 must have chlor_a and cluster_id values")
    expect = _water_codes(chl, fl, water, margin, agree, best_class, rule)
    wrong = named & np.isfinite(chl) & valid & (code != expect)
    if np.any(wrong):
        problems.append(f"{int(wrong.sum())} pixels in codes 3-8 don't follow from chlor_a, nflh and their cluster")
    if problems:
        raise ValueError("Class codes and values disagree: " + "; ".join(problems) + ". Use classify() to make class_code.")


def shallow_mask(depth_m, rule=RULE):
    """
    True where the water is shallower than RULE["shallow_max_m"]: not assessed (code 1).
    depth_m: depth below sea level in metres, positive (NaN on land). Compares the
    rounded depth, so the mask agrees with the depth.json the dashboard shows.
    """
    d = np.round(np.asarray(depth_m, dtype=float), DECIMALS["depth_m"])
    with np.errstate(invalid="ignore"):
        return np.isfinite(d) & (d < rule["shallow_max_m"])


def shallow_flag(depth_m, rule=RULE):
    """
    True where the water is assessed but shallow: at least RULE["shallow_max_m"] and under
    RULE["shallow_flag_max_m"] deep, where the seabed may still show. It never changes
    the class; the dashboard works it out from the depth file and warns. Also the zone to
    take the seabed reference spectrum from.
    """
    d = np.round(np.asarray(depth_m, dtype=float), DECIMALS["depth_m"])
    with np.errstate(invalid="ignore"):
        return np.isfinite(d) & (d >= rule["shallow_max_m"]) & (d < rule["shallow_flag_max_m"])


def write_depth(data_dir, region, bbox, res, depth_m, source):
    """
    Write data/depth_<region>.json once per area: the depth of every cell of that area's grid
    (the same bbox and res as its scenes), so the dashboard can show it. Arrays must already
    be oriented. depth_m: metres below sea level, POSITIVE (GEBCO gives negative elevation:
    use -elevation), NaN on land. Water under shallow_max_m may be NaN when the source
    leaves it out.
    """
    if region not in REGIONS:
        raise ValueError(f"region must be one of {sorted(REGIONS)}")
    if any(abs(a - b) > 1e-6 for a, b in zip(bbox, REGIONS[region]["bbox"])):
        raise ValueError(f"bbox {bbox} is not the {region} area's box {REGIONS[region]['bbox']}")
    d = np.asarray(depth_m, dtype=float)
    height, width = d.shape
    exp_w = round((bbox[2] - bbox[0]) / res[0])
    exp_h = round((bbox[3] - bbox[1]) / res[1])
    if (exp_w, exp_h) != (width, height):
        raise ValueError(f"bbox/res imply {exp_w}x{exp_h} but depth is {width}x{height}")
    if np.nanmedian(d) < 0:
        raise ValueError("depth_m is mostly negative. Store depth as positive metres below sea level (-GEBCO elevation).")
    obj = {
        "contract_version": CONTRACT_VERSION,
        "bbox": [float(v) for v in bbox],
        "res_deg": [float(v) for v in res],
        "width": int(width),
        "height": int(height),
        "units": "m",
        "source": source,
        "depth_m": _int_list(np.round(d, DECIMALS["depth_m"])),
    }
    path = os.path.join(data_dir, f"depth_{region}.json")
    os.makedirs(data_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    print(f"wrote {path} ({width}x{height}, {os.path.getsize(path) / 1e6:.2f} MB)")
    return path


def write_clusters(data_dir, wavelengths_nm, clusters, fit, units="sr^-1"):
    """
    Write data/clusters.json.
    clusters  list of cluster_record() entries
    fit       dict describing the k-means fit, e.g. {"dates": [...], "k_coarse": 6, "k_fine": 30,
              "pca_components": 5, "notes": "..."}
    units     of mean_rrs: "sr^-1", or "normalized" for curves scaled to unit length
    """
    if units not in SPECTRUM_UNITS:
        raise ValueError(f"units must be one of {SPECTRUM_UNITS}")
    wl = [round(float(w), 2) for w in wavelengths_nm]
    if any(b <= a for a, b in zip(wl, wl[1:])):
        raise ValueError("wavelengths_nm must be strictly ascending")
    ids = [c["cluster_id"] for c in clusters]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate cluster_id")
    for c in clusters:
        if len(c["mean_rrs"]) != len(wl):
            raise ValueError(f"cluster {c['cluster_id']}: mean_rrs length {len(c['mean_rrs'])} != {len(wl)} wavelengths")
    obj = {"contract_version": CONTRACT_VERSION, "units": units, "fit": fit,
           "wavelengths_nm": wl, "clusters": sorted(clusters, key=lambda c: c["cluster_id"])}
    path = os.path.join(data_dir, "clusters.json")
    os.makedirs(data_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({len(clusters)} clusters, {mb:.2f} MB)")
    if mb > MAX_CLUSTERS_MB:
        print(f"  WARNING: over {MAX_CLUSTERS_MB} MB.")
    return path


def write_grid(data_dir, scene_id, bbox, res, class_code, chlor_a, cluster_id, clusters, *, nflh):
    """
    Write data/scenes/<scene_id>/grid.json. Arrays must already be oriented (use orient_grid).
    nflh: normalized fluorescence line height in RULE["nflh_units"], NaN where missing.
    The bbox must be the scene's area box (REGIONS).
    """
    _check_scene_id(scene_id)
    code = np.asarray(class_code)
    chl = np.asarray(chlor_a, dtype=float)
    fl = np.asarray(nflh, dtype=float)
    cid = np.asarray(cluster_id, dtype=float)
    height, width = code.shape
    if width * height > MAX_CELLS:
        raise ValueError(f"{width}x{height} = {width * height} cells is over the {MAX_CELLS} limit. Use a smaller box or coarser grid.")
    region = SCENE_ID_RE.match(scene_id).group(1)
    if any(abs(a - b) > 1e-6 for a, b in zip(bbox, REGIONS[region]["bbox"])):
        raise ValueError(f"bbox {bbox} is not the {region} area's box {REGIONS[region]['bbox']}")
    named = [("chlor_a", chl), ("nflh", fl), ("cluster_id", cid)]
    for name, a in named:
        if a.shape != code.shape:
            raise ValueError(f"{name} shape {a.shape} != class_code shape {code.shape}")
    if not set(np.unique(code).tolist()) <= set(CODE.values()):
        raise ValueError("class_code contains values outside 0-8")
    _check_consistency(code, chl, fl, cid, clusters)

    exp_w = round((bbox[2] - bbox[0]) / res[0])
    exp_h = round((bbox[3] - bbox[1]) / res[1])
    if (exp_w, exp_h) != (width, height):
        raise ValueError(f"bbox/res imply {exp_w}x{exp_h} but arrays are {width}x{height}")

    # Masked pixels (codes 0-2) carry no cluster.
    cid = np.where(code >= 3, cid, np.nan)
    obj = {
        "contract_version": CONTRACT_VERSION,
        "scene_id": scene_id,
        "bbox": [float(v) for v in bbox],
        "res_deg": [float(v) for v in res],
        "width": int(width),
        "height": int(height),
        "class_code": code.astype(int).ravel(order="C").tolist(),
        "chlor_a": _flat_list(chl, DECIMALS["chlor_a"]),
        "nflh": _flat_list(fl, DECIMALS["nflh"]),
        "cluster_id": _int_list(cid),
    }

    path = os.path.join(data_dir, "scenes", scene_id, "grid.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({width}x{height}, {mb:.2f} MB)")
    if mb > MAX_GRID_MB:
        print(f"  WARNING: over {MAX_GRID_MB} MB. Use a smaller box or coarser grid.")
    return path


def pick_probes(bbox, res, class_code, chlor_a, rrs_cube, per_class=6, seed=0):
    """
    Choose sample pixels for the spectrum chart and compute class mean spectra.
    Takes oriented arrays: class_code/chlor_a (H, W) and rrs_cube (H, W, n_bands).
    Picks the highest-chlorophyll named-bloom pixels plus random pixels of the other water classes.
    """
    rng = np.random.default_rng(seed)
    code = np.asarray(class_code)
    chl = np.asarray(chlor_a, dtype=float)
    cube = np.asarray(rrs_cube)  # float32 is fine; only small slices are converted
    west, _, _, north = bbox
    probes, means = [], {}
    for c in (6, 7, 8, 5, 4, 3):
        rows, cols = np.nonzero(code == c)
        if len(rows) == 0:
            continue
        means[str(c)] = _flat_list(np.nanmean(cube[rows, cols, :], axis=0, dtype=np.float64), DECIMALS["rrs"])
        if c >= 6:
            order = np.argsort(-np.nan_to_num(chl[rows, cols], nan=-1))[:per_class]
        else:
            order = rng.choice(len(rows), size=min(per_class, len(rows)), replace=False)
        for k in order:
            r, col = int(rows[k]), int(cols[k])
            probes.append({
                "probe_id": f"p{len(probes) + 1:02d}",
                "lon": round(west + (col + 0.5) * res[0], 4),
                "lat": round(north - (r + 0.5) * res[1], 4),
                "class_code": c,
                "rrs": _flat_list(cube[r, col, :], DECIMALS["rrs"]),
            })
    return probes, means


def write_spectra(data_dir, scene_id, wavelengths_nm, probes, class_means):
    """Write data/scenes/<scene_id>/spectra.json."""
    _check_scene_id(scene_id)
    wl = [round(float(w), 2) for w in wavelengths_nm]
    if any(b <= a for a, b in zip(wl, wl[1:])):
        raise ValueError("wavelengths_nm must be strictly ascending")
    for p in probes:
        if len(p["rrs"]) != len(wl):
            raise ValueError(f"probe {p['probe_id']}: rrs length {len(p['rrs'])} != {len(wl)} wavelengths")
    for k, v in class_means.items():
        if len(v) != len(wl):
            raise ValueError(f"class_means[{k}] length {len(v)} != {len(wl)} wavelengths")
    obj = {"contract_version": CONTRACT_VERSION, "scene_id": scene_id, "units": "sr^-1",
           "wavelengths_nm": wl, "probes": probes, "class_means": class_means}
    path = os.path.join(data_dir, "scenes", scene_id, "spectra.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({len(probes)} probes, {mb:.2f} MB)")
    if mb > MAX_SPECTRA_MB:
        print(f"  WARNING: over {MAX_SPECTRA_MB} MB. Use fewer probes.")
    return path


def write_references(data_dir, references):
    """
    Write data/references.json. One item per entry of REFERENCES, each with:
    ref_id, label, source, source_url, units, wavelengths_nm, rrs, notes.
    The group (bloom / water) is filled in from REFERENCES. units: "sr^-1" (the default),
    or "normalized" for curves scaled to unit length.
    """
    ids = [r.get("ref_id") for r in references]
    if sorted(ids) != sorted(REFERENCES):
        raise ValueError(f"references must be exactly {sorted(REFERENCES)} (got {ids})")
    for r in references:
        missing = {"ref_id", "label", "source", "wavelengths_nm", "rrs"} - set(r)
        if missing:
            raise ValueError(f"reference {r.get('ref_id')}: missing {sorted(missing)}")
        if len(r["wavelengths_nm"]) != len(r["rrs"]):
            raise ValueError(f"reference {r['ref_id']}: wavelengths and rrs lengths differ")
        r["group"] = REFERENCES[r["ref_id"]]["group"]
        r.setdefault("units", "sr^-1")
        if r["units"] not in SPECTRUM_UNITS:
            raise ValueError(f"reference {r['ref_id']}: units must be one of {SPECTRUM_UNITS}")
    path = os.path.join(data_dir, "references.json")
    os.makedirs(data_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump({"contract_version": CONTRACT_VERSION, "references": references}, f, indent=1, allow_nan=False)
    print(f"wrote {path} ({len(references)} references)")
    return path


def update_manifest(data_dir, scene):
    """
    Add or replace one scene in data/manifest.json (matched by scene_id), and refresh
    the rule, classes, risk tiers and regions blocks from this file.

    scene needs: scene_id, role, status, title, context. Optional: source_url, products
    (list of product short names), links (list of {"label", "url"}: more sources to show).
    region/sensor/date/files are filled in from scene_id.
    """
    sid = scene["scene_id"]
    _check_scene_id(sid)
    region, sensor, ymd = SCENE_ID_RE.match(sid).groups()
    entry = {
        "scene_id": sid,
        "region": region,
        "sensor": sensor,
        "date": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}",
        "role": scene["role"],
        "status": scene["status"],
        "title": scene["title"],
        "context": scene.get("context", ""),
        "source_url": scene.get("source_url"),
        "products": list(scene.get("products", [])),
        "links": [{"label": str(x["label"]), "url": str(x["url"])} for x in scene.get("links", [])],
        "files": {"grid": f"scenes/{sid}/grid.json", "spectra": None},
    }
    if entry["role"] not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    if entry["status"] not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    if not os.path.exists(os.path.join(data_dir, entry["files"]["grid"])):
        raise FileNotFoundError(f"write_grid() first: {entry['files']['grid']} is missing")
    if os.path.exists(os.path.join(data_dir, "scenes", sid, "spectra.json")):
        entry["files"]["spectra"] = f"scenes/{sid}/spectra.json"

    path = os.path.join(data_dir, "manifest.json")
    scenes = []
    if os.path.exists(path):
        with open(path) as f:
            scenes = json.load(f).get("scenes", [])
    scenes = [s for s in scenes if s["scene_id"] != sid] + [entry]
    scenes.sort(key=lambda s: (s["region"], s["date"], s["sensor"]))
    write_manifest(data_dir, scenes)
    return path


def write_manifest(data_dir, scenes):
    """
    Write data/manifest.json with the given scene entries and the current rule blocks.
    The areas listed are the ones the scenes use, each naming its depth file when it exists.
    """
    used = {s["region"] for s in scenes} or set(REGIONS)
    regions = {}
    for key, info in REGIONS.items():
        if key in used:
            depth = f"depth_{key}.json"
            regions[key] = dict(info, depth_file=depth if os.path.exists(os.path.join(data_dir, depth)) else None)
    manifest = {
        "contract_version": CONTRACT_VERSION,
        "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rule": RULE,
        "risk_tiers": RISK_TIERS,
        "classes": CLASSES,
        "regions": regions,
        "scenes": scenes,
    }
    path = os.path.join(data_dir, "manifest.json")
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2, allow_nan=False)
    print(f"updated {path} ({len(scenes)} scenes)")
    return path


# ---------------------------------------------------------------------------
# 5. Example: what a real export looks like. Replace the TODOs with your code.
# ---------------------------------------------------------------------------
def export_scene_example():
    DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
    scene_id = "gulf_pace_20260314"

    # TODO 1: load the gridded scene (Level-2 AOP + BGC, nearest-neighbour resampled to the 0.01 deg grid
    #         over the area's box, REGIONS["gulf"]["bbox"])
    #   lat, lon     -> 1-D cell centers
    #   rrs          -> (lat, lon, band) in sr^-1
    #   wavelengths  -> (band,) nm
    #   chlor_a      -> (lat, lon) in mg m^-3
    #   nflh         -> (lat, lon) in RULE["nflh_units"]
    #   depth        -> (lat, lon) GEBCO depth on the same cells, positive metres (NaN on land)
    lat = lon = rrs = wavelengths = chlor_a = nflh = depth = None
    raise NotImplementedError("Fill in TODO 1-4, then delete this line.")

    # TODO 2: masks, same 2-D shape: land, quality flags (cloud, glint...); shallow from the depth
    land = no_data = None
    shallow = shallow_mask(depth)

    # TODO 3: cluster_id per pixel from your fitted k-means (kmeans.predict on held-out dates),
    #         and the cluster table written once with write_clusters() (cluster_record() per cluster)
    cluster_id = clusters = None

    code = classify(chlor_a, cluster_id, clusters, land, no_data, shallow, nflh=nflh)
    bbox, res, (code, chlor_a, nflh, cluster_id, rrs, depth) = orient_grid(lat, lon, code, chlor_a, nflh, cluster_id, rrs, depth)
    write_depth(DATA_DIR, "gulf", bbox, res, depth, source="GEBCO, resampled to the 0.01 deg grid")  # once per area
    write_grid(DATA_DIR, scene_id, bbox, res, code, chlor_a, cluster_id, clusters, nflh=nflh)
    probes, means = pick_probes(bbox, res, code, chlor_a, rrs)
    write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)

    # TODO 4: scene description
    update_manifest(DATA_DIR, {
        "scene_id": scene_id,
        "role": "analysis_bloom",
        "status": "real",
        "title": "Analysis date (bloom season)",
        "context": "Bloom-season date pooled into the k-means fit.",
        "products": ["PACE_OCI_L2_AOP", "PACE_OCI_L2_BGC", "PACE_OCI_L2_IOP"],
    })


if __name__ == "__main__":
    print(__doc__)

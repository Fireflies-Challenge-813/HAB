"""
export_contract.py: write pipeline outputs in the exact format of docs/DATA_CONTRACT.md.

Use these functions instead of writing JSON by hand, so that names, grid
orientation, class codes and units can't drift between the pipeline and the
dashboard.

Requires: numpy (nothing else).

Typical use for one scene (see export_scene_example() at the bottom):

    ratio, nflh, bands = compute_rule_inputs(rrs, wavelengths, f0, flh_base_high_nm=717)
    code = classify(ratio, nflh, land, no_data, shallow)
    bbox, res, (code, ratio, nflh, rrs) = orient_grid(lat, lon, code, ratio, nflh, rrs)
    write_grid(DATA_DIR, scene_id, bbox, res, code, ratio, nflh)
    probes, means = pick_probes(bbox, res, code, ratio, rrs)
    write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)
    update_manifest(DATA_DIR, {...scene info..., "bands_used_nm": bands})
"""

import datetime
import json
import os
import re

import numpy as np

CONTRACT_VERSION = "1.0"

# ---------------------------------------------------------------------------
# The ONLY place the rule thresholds are defined. update_manifest() copies
# this block into data/manifest.json, and the dashboard reads it from there.
# ---------------------------------------------------------------------------
RULE = {
    "name": "Ghanea, Moradi & Kabiri (2016) MODIS rule, computed on PACE",
    "citation": (
        "Ghanea, M., Moradi, M., Kabiri, K. (2016). A novel method for characterizing "
        "harmful algal blooms in the Persian Gulf using MODIS measurements. "
        "Advances in Space Research 58(7), 1348-1361."
    ),
    "citation_url": "https://www.sciencedirect.com/science/article/abs/pii/S0273117716302848",
    "ratio_name": "Rrs(667)/Rrs(443)",
    "ratio_min": 1.0,
    "nflh_min": 0.04,
    "nflh_units": "mW cm^-2 um^-1 sr^-1",
    "shallow_max_m": 10.0,  # TODO agree as a team
    "sam_max_deg": 10.0,    # display only: the optional similarity score never changes the class
}

CLASSES = [
    {"code": 0, "key": "land", "label": "Land"},
    {"code": 1, "key": "no_data", "label": "No data"},
    {"code": 2, "key": "shallow", "label": "Shallow water (masked)"},
    {"code": 3, "key": "clear", "label": "Water, no bloom"},
    {"code": 4, "key": "bloom_other", "label": "Bloom, not C. polykrikoides-like"},
    {"code": 5, "key": "cp_like", "label": "C. polykrikoides-like bloom"},
]
CODE = {c["key"]: c["code"] for c in CLASSES}

REGIONS = {
    "gulf": {"label": "Arabian Gulf and Sea of Oman", "bbox": [47.5, 22.0, 60.0, 30.5]},
    "korea": {"label": "Korean south coast (test site)", "bbox": [125.5, 33.0, 130.5, 36.0]},
}
SENSORS = ("pace", "modis")
ROLES = ("true_positive_test", "probable_negative_test", "implementation_check", "monitoring")
STATUSES = ("mock", "real")
SCENE_ID_RE = re.compile(r"^(gulf|korea)_(pace|modis)_(\d{8})$")

# Decimals used when writing grid.json. classify() compares the ROUNDED values,
# so the class always agrees with the number the dashboard shows.
DECIMALS = {"ratio_667_443": 3, "nflh": 4, "sam_deg": 1}

MAX_CELLS = 250_000
MAX_GRID_MB = 6.0
MAX_SPECTRA_MB = 1.0
BAND_TOLERANCE_NM = 3.0


# ---------------------------------------------------------------------------
# 1. The rule
# ---------------------------------------------------------------------------
def nearest_band(wavelengths, target_nm):
    """Index and wavelength of the band closest to target_nm."""
    w = np.asarray(wavelengths, dtype=float)
    i = int(np.argmin(np.abs(w - target_nm)))
    return i, float(w[i])


def compute_rule_inputs(rrs, wavelengths, f0, flh_base_high_nm=748.0):
    """
    Compute the two numbers the rule needs, in contract units.

    rrs              array (..., n_bands), remote-sensing reflectance in sr^-1
    wavelengths      (n_bands,) band centers in nm
    f0               (n_bands,) solar irradiance in mW cm^-2 um^-1 for the same bands
    flh_base_high_nm 748 for MODIS. Standard PACE Rrs stops at ~719 nm, so pass ~717
                     (or use l2gen-modeled Rrs at 748) and say so in the pitch.

    Returns ratio_667_443, nflh (mW cm^-2 um^-1 sr^-1), bands_used_nm (dict for the manifest).
    """
    rrs = np.asarray(rrs, dtype=float)
    f0 = np.asarray(f0, dtype=float)

    targets = {"ratio_den": 443.0, "ratio_num": 667.0, "flh_peak": 678.0,
               "flh_base_low": 667.0, "flh_base_high": float(flh_base_high_nm)}
    idx, used = {}, {}
    for name, target in targets.items():
        i, w = nearest_band(wavelengths, target)
        if abs(w - target) > BAND_TOLERANCE_NM:
            raise ValueError(f"{name}: nearest band to {target} nm is {w} nm (more than "
                             f"{BAND_TOLERANCE_NM} nm away). Check your wavelengths.")
        idx[name], used[name] = i, round(w, 2)

    with np.errstate(divide="ignore", invalid="ignore"):
        den = rrs[..., idx["ratio_den"]]
        ratio = rrs[..., idx["ratio_num"]] / den
        ratio[~(den > 0)] = np.nan

        def nlw(name):
            return rrs[..., idx[name]] * f0[idx[name]]

        w_lo, w_pk, w_hi = used["flh_base_low"], used["flh_peak"], used["flh_base_high"]
        baseline = nlw("flh_base_low") + (nlw("flh_base_high") - nlw("flh_base_low")) * (w_pk - w_lo) / (w_hi - w_lo)
        nflh = nlw("flh_peak") - baseline

    ratio[~np.isfinite(ratio)] = np.nan
    nflh[~np.isfinite(nflh)] = np.nan
    return ratio, nflh, used


def classify(ratio, nflh, land, no_data, shallow, rule=RULE):
    """
    Class code for every pixel. All inputs have the same 2-D shape.
    land, no_data, shallow: boolean masks (True = masked).
    Precedence: land > no_data > shallow > rule.
    """
    ratio = np.round(np.asarray(ratio, dtype=float), DECIMALS["ratio_667_443"])
    nflh = np.round(np.asarray(nflh, dtype=float), DECIMALS["nflh"])
    code = np.full(ratio.shape, CODE["clear"], dtype=np.int8)

    bloom = nflh > rule["nflh_min"]
    code[bloom & (ratio <= rule["ratio_min"])] = CODE["bloom_other"]
    code[bloom & (ratio > rule["ratio_min"])] = CODE["cp_like"]

    missing = ~np.isfinite(ratio) | ~np.isfinite(nflh)
    code[np.asarray(shallow, dtype=bool)] = CODE["shallow"]
    code[np.asarray(no_data, dtype=bool) | missing] = CODE["no_data"]
    code[np.asarray(land, dtype=bool)] = CODE["land"]
    return code


# ---------------------------------------------------------------------------
# 2. Grid orientation
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
            raise ValueError(f"{name} is not regularly spaced. Regrid to a regular lat/lon grid first.")

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
# 3. Writers
# ---------------------------------------------------------------------------
def _flat_list(a, decimals):
    """Flatten row-major, round, and turn NaN into None (JSON null)."""
    a = np.asarray(a, dtype=float).ravel(order="C")
    vals = np.round(a, decimals).astype(object)
    vals[~np.isfinite(a)] = None
    return vals.tolist()


def _check_scene_id(scene_id):
    if not SCENE_ID_RE.match(scene_id):
        raise ValueError(f"scene_id '{scene_id}' must look like gulf_pace_20250308 (region_sensor_YYYYMMDD)")


def _check_consistency(code, ratio, nflh, rule=RULE):
    """Raise if class codes don't match the values. This catches unit and band mix-ups early."""
    ratio = np.round(ratio, DECIMALS["ratio_667_443"])
    nflh = np.round(nflh, DECIMALS["nflh"])
    problems = []
    water = np.isin(code, [3, 4, 5])
    if np.any(water & ~(np.isfinite(ratio) & np.isfinite(nflh))):
        problems.append("codes 3-5 must have ratio and nflh values")
    with np.errstate(invalid="ignore"):
        if np.any((code == 5) & ~((nflh > rule["nflh_min"]) & (ratio > rule["ratio_min"]))):
            problems.append("some code-5 pixels don't pass the rule")
        if np.any((code == 4) & ~((nflh > rule["nflh_min"]) & (ratio <= rule["ratio_min"]))):
            problems.append("some code-4 pixels don't match the rule")
        if np.any((code == 3) & ~(nflh <= rule["nflh_min"])):
            problems.append("some code-3 pixels have nflh above the threshold")
    if problems:
        raise ValueError("Class codes and values disagree: " + "; ".join(problems) +
                         ". Use classify() to make class_code.")


def write_grid(data_dir, scene_id, bbox, res, class_code, ratio_667_443, nflh, sam_deg=None):
    """Write data/scenes/<scene_id>/grid.json. Arrays must already be oriented (use orient_grid)."""
    _check_scene_id(scene_id)
    code = np.asarray(class_code)
    ratio = np.asarray(ratio_667_443, dtype=float)
    fl = np.asarray(nflh, dtype=float)
    height, width = code.shape
    if width * height > MAX_CELLS:
        raise ValueError(f"{width}x{height} = {width * height} cells is over the {MAX_CELLS} limit. Use a smaller box or coarser grid.")
    for name, a in (("ratio_667_443", ratio), ("nflh", fl)) + ((("sam_deg", np.asarray(sam_deg)),) if sam_deg is not None else ()):
        if a.shape != code.shape:
            raise ValueError(f"{name} shape {a.shape} != class_code shape {code.shape}")
    if not set(np.unique(code).tolist()) <= {0, 1, 2, 3, 4, 5}:
        raise ValueError("class_code contains values outside 0-5")
    _check_consistency(code, ratio, fl)

    exp_w = round((bbox[2] - bbox[0]) / res[0])
    exp_h = round((bbox[3] - bbox[1]) / res[1])
    if (exp_w, exp_h) != (width, height):
        raise ValueError(f"bbox/res imply {exp_w}x{exp_h} but arrays are {width}x{height}")

    obj = {
        "contract_version": CONTRACT_VERSION,
        "scene_id": scene_id,
        "bbox": [float(v) for v in bbox],
        "res_deg": [float(v) for v in res],
        "width": int(width),
        "height": int(height),
        "class_code": code.astype(int).ravel(order="C").tolist(),
        "ratio_667_443": _flat_list(ratio, DECIMALS["ratio_667_443"]),
        "nflh": _flat_list(fl, DECIMALS["nflh"]),
    }
    if sam_deg is not None:
        obj["sam_deg"] = _flat_list(sam_deg, DECIMALS["sam_deg"])

    path = os.path.join(data_dir, "scenes", scene_id, "grid.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    mb = os.path.getsize(path) / 1e6
    print(f"wrote {path} ({width}x{height}, {mb:.2f} MB)")
    if mb > MAX_GRID_MB:
        print(f"  WARNING: over {MAX_GRID_MB} MB. Use a smaller box or coarser grid.")
    return path


def pick_probes(bbox, res, class_code, ratio, rrs_cube, per_class=8, seed=0):
    """
    Choose sample pixels for the spectrum chart and compute class mean spectra.
    Takes oriented arrays: class_code/ratio (H, W) and rrs_cube (H, W, n_bands).
    Picks the highest-ratio cp_like pixels plus random bloom_other and clear pixels.
    """
    rng = np.random.default_rng(seed)
    code = np.asarray(class_code)
    cube = np.asarray(rrs_cube, dtype=float)
    west, _, _, north = bbox
    probes, means = [], {}
    for c in (5, 4, 3):
        rows, cols = np.nonzero(code == c)
        if len(rows) == 0:
            continue
        means[str(c)] = _flat_list(np.nanmean(cube[rows, cols, :], axis=0), 5)
        if c == 5:
            order = np.argsort(-np.nan_to_num(np.asarray(ratio)[rows, cols], nan=-1))[:per_class]
        else:
            order = rng.choice(len(rows), size=min(per_class, len(rows)), replace=False)
        for k in order:
            r, col = int(rows[k]), int(cols[k])
            probes.append({
                "probe_id": f"p{len(probes) + 1:02d}",
                "lon": round(west + (col + 0.5) * res[0], 4),
                "lat": round(north - (r + 0.5) * res[1], 4),
                "class_code": c,
                "rrs": _flat_list(cube[r, col, :], 5),
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
    """Write data/references.json. Each item: ref_id, label, source, source_url, units, wavelengths_nm, rrs, notes."""
    for r in references:
        missing = {"ref_id", "label", "source", "wavelengths_nm", "rrs"} - set(r)
        if missing:
            raise ValueError(f"reference {r.get('ref_id')}: missing {sorted(missing)}")
        if len(r["wavelengths_nm"]) != len(r["rrs"]):
            raise ValueError(f"reference {r['ref_id']}: wavelengths and rrs lengths differ")
        r.setdefault("units", "sr^-1")
    path = os.path.join(data_dir, "references.json")
    with open(path, "w") as f:
        json.dump({"contract_version": CONTRACT_VERSION, "references": references}, f, indent=1, allow_nan=False)
    print(f"wrote {path} ({len(references)} references)")
    return path


def update_manifest(data_dir, scene):
    """
    Add or replace one scene in data/manifest.json (matched by scene_id), and refresh
    the rule, classes and regions blocks from this file.

    scene needs: scene_id, role, status, title, context. Optional: source_url, product,
    bands_used_nm, f0_source. region/sensor/date/files are filled in from scene_id.
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
        "product": scene.get("product", ""),
        "bands_used_nm": scene.get("bands_used_nm"),
        "f0_source": scene.get("f0_source", ""),
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

    manifest = {
        "contract_version": CONTRACT_VERSION,
        "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rule": RULE,
        "classes": CLASSES,
        "regions": REGIONS,
        "scenes": scenes,
    }
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2, allow_nan=False)
    print(f"updated {path} ({len(scenes)} scenes)")
    return path


# ---------------------------------------------------------------------------
# 4. Example: what a real export looks like. Replace the TODOs with your code.
# ---------------------------------------------------------------------------
def export_scene_example():
    DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
    scene_id = "gulf_pace_20250308"

    # TODO 1: load your scene (e.g. xarray.open_dataset on a PACE L3M Rrs file)
    #   lat, lon     -> 1-D cell centers
    #   rrs          -> (lat, lon, band) in sr^-1
    #   wavelengths  -> (band,) nm
    #   f0           -> (band,) mW cm^-2 um^-1
    lat = lon = rrs = wavelengths = f0 = None
    raise NotImplementedError("Fill in TODO 1-3, then delete this line.")

    # TODO 2: the rule inputs. PACE: baseline at ~717 nm (log it). MODIS: 748.
    ratio, nflh, bands = compute_rule_inputs(rrs, wavelengths, f0, flh_base_high_nm=717)

    # TODO 3: masks, same 2-D shape as ratio
    land = no_data = shallow = None   # land mask, cloud/dust/quality flags, depth < RULE["shallow_max_m"]

    code = classify(ratio, nflh, land, no_data, shallow)
    bbox, res, (code, ratio, nflh, rrs) = orient_grid(lat, lon, code, ratio, nflh, rrs)
    write_grid(DATA_DIR, scene_id, bbox, res, code, ratio, nflh)
    probes, means = pick_probes(bbox, res, code, ratio, rrs)
    write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)
    update_manifest(DATA_DIR, {
        "scene_id": scene_id,
        "role": "probable_negative_test",
        "status": "real",
        "title": "Gulf of Oman swirls",
        "context": "NASA Earth Observatory: swirls likely include Noctiluca (not confirmed by sampling).",
        "source_url": "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/",
        "product": "PACE OCI L3M Rrs 4 km",
        "bands_used_nm": bands,
        "f0_source": "TODO: where your F0 values came from",
    })


if __name__ == "__main__":
    print(__doc__)

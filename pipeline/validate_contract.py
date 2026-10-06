"""
validate_contract.py: check everything in data/ against docs/DATA_CONTRACT.md.

Run before every push:
    python pipeline/validate_contract.py data

Ends with PASS or FAIL. FAIL means the dashboard will break or show wrong data.
WARN means something looks suspicious (wrong units, upside-down grid...). Read it.

Standard library only, so anyone can run it.
"""

import json
import math
import os
import re
import statistics
import sys

SUPPORTED_MAJOR = "1"
CLASS_KEYS = {0: "land", 1: "no_data", 2: "shallow", 3: "clear", 4: "bloom_other", 5: "cp_like"}
REGIONS = {"gulf", "korea"}
SENSORS = {"pace", "modis"}
ROLES = {"true_positive_test", "probable_negative_test", "implementation_check", "monitoring"}
STATUSES = {"mock", "real"}
SITE_TYPES = {"desalination", "aquaculture", "beach", "port", "other"}
SCENE_ID_RE = re.compile(r"^(gulf|korea)_(pace|modis)_(\d{8})$")
MAX_CELLS = 250_000
MAX_GRID_MB = 6.0
MAX_SPECTRA_MB = 1.0

# Points that are clearly land or clearly sea. Used to catch upside-down grids.
ORIENTATION_POINTS = {
    "gulf": {"land": [(49.0, 24.0), (55.0, 29.5)], "sea": [(52.0, 27.0), (58.0, 24.5)]},
    "korea": {"land": [(127.5, 35.5)], "sea": [(128.0, 33.8)]},
}


class Report:
    def __init__(self):
        self.fails, self.warns = [], []

    def fail(self, where, msg):
        self.fails.append(f"FAIL  {where}: {msg}")

    def warn(self, where, msg):
        self.warns.append(f"WARN  {where}: {msg}")


def load_json(path, rep, where):
    if not os.path.exists(path):
        rep.fail(where, f"file not found: {path}")
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        rep.fail(where, f"not valid JSON ({e}). NaN/Infinity are not allowed; use null.")
        return None


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_version(obj, rep, where):
    v = str(obj.get("contract_version", ""))
    if v.split(".")[0] != SUPPORTED_MAJOR:
        rep.fail(where, f"contract_version '{v}' (this validator supports {SUPPORTED_MAJOR}.x)")


def check_manifest(m, rep):
    w = "manifest.json"
    check_version(m, rep, w)
    rule = m.get("rule", {})
    for k in ("ratio_min", "nflh_min", "sam_max_deg", "shallow_max_m"):
        if not is_num(rule.get(k)):
            rep.fail(w, f"rule.{k} must be a number")
    if rule.get("nflh_units") != "mW cm^-2 um^-1 sr^-1":
        rep.fail(w, "rule.nflh_units must be 'mW cm^-2 um^-1 sr^-1'")
    codes = {c.get("code"): c.get("key") for c in m.get("classes", [])}
    if codes != CLASS_KEYS:
        rep.fail(w, f"classes must be exactly {CLASS_KEYS}")
    for r, info in m.get("regions", {}).items():
        b = info.get("bbox")
        if r not in REGIONS or not (isinstance(b, list) and len(b) == 4 and all(is_num(x) for x in b)):
            rep.fail(w, f"regions.{r} must be a known region with a 4-number bbox")
    ids = [s.get("scene_id") for s in m.get("scenes", [])]
    if len(ids) != len(set(ids)):
        rep.fail(w, "duplicate scene_id in scenes")
    if not ids:
        rep.warn(w, "no scenes listed")
    for s in m.get("scenes", []):
        sid = s.get("scene_id", "?")
        sw = f"manifest scene {sid}"
        mt = SCENE_ID_RE.match(sid)
        if not mt:
            rep.fail(sw, "scene_id must look like gulf_pace_20250308")
            continue
        region, sensor, ymd = mt.groups()
        date = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
        if s.get("region") != region or s.get("sensor") != sensor or s.get("date") != date:
            rep.fail(sw, f"region/sensor/date must match the id ({region}, {sensor}, {date})")
        if s.get("role") not in ROLES:
            rep.fail(sw, f"role must be one of {sorted(ROLES)}")
        if s.get("status") not in STATUSES:
            rep.fail(sw, "status must be 'mock' or 'real'")
        if not s.get("title"):
            rep.fail(sw, "title is required")
        files = s.get("files", {})
        if files.get("grid") != f"scenes/{sid}/grid.json":
            rep.fail(sw, f"files.grid must be 'scenes/{sid}/grid.json'")
        if files.get("spectra") not in (None, f"scenes/{sid}/spectra.json"):
            rep.fail(sw, f"files.spectra must be null or 'scenes/{sid}/spectra.json'")
        if s.get("status") == "real":
            b = s.get("bands_used_nm") or {}
            if not all(is_num(b.get(k)) for k in ("ratio_num", "ratio_den", "flh_peak", "flh_base_low", "flh_base_high")):
                rep.warn(sw, "real scene without a complete bands_used_nm log")
            elif sensor == "pace" and b["flh_base_high"] < 740:
                rep.warn(sw, f"PACE FLH baseline at {b['flh_base_high']} nm (MODIS rule used 748 nm). Mention this in the pitch.")


def lookup(g, lon, lat):
    west, south, east, north = g["bbox"]
    if not (west <= lon < east and south < lat <= north):
        return None
    col = int((lon - west) / g["res_deg"][0])
    row = int((north - lat) / g["res_deg"][1])
    if 0 <= row < g["height"] and 0 <= col < g["width"]:
        return g["class_code"][row * g["width"] + col]
    return None


def check_grid(g, scene, rule, regions, rep, path):
    sid = scene["scene_id"]
    w = f"{sid}/grid.json"
    check_version(g, rep, w)
    if g.get("scene_id") != sid:
        rep.fail(w, f"scene_id '{g.get('scene_id')}' doesn't match folder '{sid}'")
    b, r = g.get("bbox"), g.get("res_deg")
    W, H = g.get("width"), g.get("height")
    if not (isinstance(b, list) and len(b) == 4 and all(is_num(x) for x in b) and b[0] < b[2] and b[1] < b[3]):
        rep.fail(w, "bbox must be [west, south, east, north] with west<east, south<north")
        return
    if not (isinstance(r, list) and len(r) == 2 and all(is_num(x) and x > 0 for x in r)):
        rep.fail(w, "res_deg must be [res_lon, res_lat], both positive")
        return
    if not (isinstance(W, int) and isinstance(H, int) and W > 0 and H > 0):
        rep.fail(w, "width and height must be positive integers")
        return
    if abs((b[2] - b[0]) / r[0] - W) > 0.5 or abs((b[3] - b[1]) / r[1] - H) > 0.5:
        rep.fail(w, f"bbox/res_deg imply {(b[2]-b[0])/r[0]:.1f} x {(b[3]-b[1])/r[1]:.1f} cells, but width x height is {W} x {H}")
    if W * H > MAX_CELLS:
        rep.fail(w, f"{W * H} cells is over the {MAX_CELLS} limit")
    rb = regions.get(scene.get("region"), {}).get("bbox")
    if rb and (b[0] < rb[0] - 0.5 or b[1] < rb[1] - 0.5 or b[2] > rb[2] + 0.5 or b[3] > rb[3] + 0.5):
        rep.warn(w, f"bbox {b} extends outside the {scene.get('region')} region box {rb}")

    n = W * H
    arrays = {"class_code": True, "ratio_667_443": True, "nflh": True, "sam_deg": False}
    for name, required in arrays.items():
        a = g.get(name)
        if a is None:
            if required:
                rep.fail(w, f"missing array '{name}'")
            continue
        if not isinstance(a, list) or len(a) != n:
            rep.fail(w, f"'{name}' must be a flat list of width*height = {n} values (got {len(a) if isinstance(a, list) else type(a).__name__})")
            return
    codes, ratio, nflh = g["class_code"], g["ratio_667_443"], g["nflh"]
    bad_codes = sum(1 for c in codes if c not in CLASS_KEYS)
    if bad_codes:
        rep.fail(w, f"{bad_codes} class_code values outside 0-5 (null is not allowed here)")
        return

    rmin, fmin = rule.get("ratio_min", 1.0), rule.get("nflh_min", 0.04)
    nulls, wrong5, wrong4, wrong3 = 0, 0, 0, 0
    water_ratio = []
    for c, rv, fv in zip(codes, ratio, nflh):
        if c < 3:
            continue
        if not (is_num(rv) and is_num(fv)):
            nulls += 1
            continue
        water_ratio.append(rv)
        if c == 5 and not (fv > fmin and rv > rmin):
            wrong5 += 1
        elif c == 4 and not (fv > fmin and rv <= rmin):
            wrong4 += 1
        elif c == 3:
            if not fv <= fmin:
                wrong3 += 1
    if nulls:
        rep.fail(w, f"{nulls} water pixels (codes 3-5) have null ratio or nflh")
    for cnt, label in ((wrong5, "code 5"), (wrong4, "code 4"), (wrong3, "code 3")):
        if cnt:
            rep.fail(w, f"{cnt} {label} pixels disagree with the rule thresholds. Use classify().")

    counts = {k: codes.count(k) for k in CLASS_KEYS}
    water = counts[3] + counts[4] + counts[5]
    if water == 0:
        rep.warn(w, "no usable water pixels (codes 3-5) at all")
    if water and (counts[4] + counts[5]) / water > 0.5:
        rep.warn(w, f"{100 * (counts[4] + counts[5]) / water:.0f}% of water pixels are blooms. "
                    "nflh may be 10x too big (W m^-2 instead of mW cm^-2: divide by 10).")
    if water_ratio and statistics.median(water_ratio) > 1.5:
        rep.warn(w, "median ratio over all water is > 1.5. Are 667 and 443 swapped?")

    for kind, pts in ORIENTATION_POINTS.get(scene.get("region"), {}).items():
        for lon, lat in pts:
            c = lookup(g, lon, lat)
            if c is None:
                continue
            if kind == "land" and c in (3, 4, 5):
                rep.warn(w, f"({lon}, {lat}) is land but has water class {c}. Grid upside down (row 0 must be north)?")
            if kind == "sea" and c == 0:
                rep.warn(w, f"({lon}, {lat}) is sea but has class 0 (land). Grid upside down (row 0 must be north)?")

    if "sam_deg" in g:
        bad = sum(1 for v in g["sam_deg"] if v is not None and not (is_num(v) and 0 <= v <= 90))
        if bad:
            rep.fail(w, f"{bad} sam_deg values outside 0-90 degrees")
    mb = os.path.getsize(path) / 1e6
    if mb > MAX_GRID_MB:
        rep.warn(w, f"{mb:.1f} MB is over the {MAX_GRID_MB} MB guideline")
    share = ", ".join(f"{CLASS_KEYS[k]} {counts[k]}" for k in CLASS_KEYS)
    print(f"  {sid}: {W}x{H} cells, {mb:.2f} MB  [{share}]")
    return g


def check_spectra(sp, scene, g, rep, path):
    sid = scene["scene_id"]
    w = f"{sid}/spectra.json"
    check_version(sp, rep, w)
    if sp.get("scene_id") != sid:
        rep.fail(w, "scene_id doesn't match the folder")
    wl = sp.get("wavelengths_nm")
    if not (isinstance(wl, list) and wl and all(is_num(x) for x in wl)):
        rep.fail(w, "wavelengths_nm must be a non-empty list of numbers")
        return
    if any(b <= a for a, b in zip(wl, wl[1:])):
        rep.fail(w, "wavelengths_nm must be strictly ascending")
    if not (300 <= wl[0] and wl[-1] <= 1000):
        rep.warn(w, f"wavelengths run {wl[0]}-{wl[-1]} nm. Are these nanometres?")
    for p in sp.get("probes", []):
        pid = p.get("probe_id", "?")
        if len(p.get("rrs", [])) != len(wl):
            rep.fail(w, f"probe {pid}: rrs length != wavelengths length")
        if p.get("class_code") not in CLASS_KEYS:
            rep.fail(w, f"probe {pid}: class_code must be 0-5")
        if g and is_num(p.get("lon")) and is_num(p.get("lat")):
            b = g["bbox"]
            if not (b[0] <= p["lon"] <= b[2] and b[1] <= p["lat"] <= b[3]):
                rep.fail(w, f"probe {pid} is outside the grid bbox")
    for k, v in (sp.get("class_means") or {}).items():
        if k not in {str(c) for c in CLASS_KEYS}:
            rep.fail(w, f"class_means key '{k}' must be a class code as a string")
        elif len(v) != len(wl):
            rep.fail(w, f"class_means['{k}'] length != wavelengths length")
    rrs_vals = [x for p in sp.get("probes", []) for x in p.get("rrs", []) if is_num(x)]
    if rrs_vals and max(rrs_vals) > 0.2:
        rep.warn(w, "Rrs above 0.2 sr^-1. Is this Rrs (sr^-1) and not reflectance (%) or radiance?")
    mb = os.path.getsize(path) / 1e6
    if mb > MAX_SPECTRA_MB:
        rep.warn(w, f"{mb:.1f} MB is over the {MAX_SPECTRA_MB} MB guideline")


def check_references(refs, rep):
    w = "references.json"
    check_version(refs, rep, w)
    for r in refs.get("references", []):
        rid = r.get("ref_id", "?")
        for k in ("ref_id", "label", "source", "wavelengths_nm", "rrs"):
            if k not in r:
                rep.fail(w, f"{rid}: missing '{k}'")
        if len(r.get("wavelengths_nm", [])) != len(r.get("rrs", [])):
            rep.fail(w, f"{rid}: wavelengths_nm and rrs lengths differ")
        if "placeholder" in (r.get("label", "") + r.get("notes", "")).lower():
            rep.warn(w, f"{rid} is still a placeholder. Replace it with the published field spectrum before the demo.")


def check_sites(sites, rep):
    w = "sites.geojson"
    if sites.get("type") != "FeatureCollection":
        rep.fail(w, "must be a GeoJSON FeatureCollection")
        return
    ids = set()
    for f in sites.get("features", []):
        p = f.get("properties", {})
        sid = p.get("site_id", "?")
        geom = f.get("geometry", {})
        if geom.get("type") != "Point" or len(geom.get("coordinates", [])) != 2:
            rep.fail(w, f"{sid}: geometry must be a Point [lon, lat]")
            continue
        lon, lat = geom["coordinates"]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            rep.fail(w, f"{sid}: coordinates out of range")
        elif abs(lon) < 90 and lat > 40:
            rep.warn(w, f"{sid}: [{lon}, {lat}]. Swapped? GeoJSON is [lon, lat]")
        for k in ("site_id", "name", "type", "region"):
            if not p.get(k):
                rep.fail(w, f"{sid}: missing property '{k}'")
        if p.get("type") not in SITE_TYPES:
            rep.fail(w, f"{sid}: type must be one of {sorted(SITE_TYPES)}")
        if p.get("region") not in REGIONS:
            rep.fail(w, f"{sid}: region must be one of {sorted(REGIONS)}")
        if sid in ids:
            rep.fail(w, f"duplicate site_id {sid}")
        ids.add(sid)


def main(data_dir):
    rep = Report()
    print(f"Checking {os.path.abspath(data_dir)}")
    m = load_json(os.path.join(data_dir, "manifest.json"), rep, "manifest.json")
    if m:
        check_manifest(m, rep)
        rule, regions = m.get("rule", {}), m.get("regions", {})
        for s in m.get("scenes", []):
            if not SCENE_ID_RE.match(s.get("scene_id", "")):
                continue
            gpath = os.path.join(data_dir, "scenes", s["scene_id"], "grid.json")
            g = load_json(gpath, rep, f"{s['scene_id']}/grid.json")
            g = check_grid(g, s, rule, regions, rep, gpath) if g else None
            if (s.get("files") or {}).get("spectra"):
                spath = os.path.join(data_dir, s["files"]["spectra"])
                sp = load_json(spath, rep, f"{s['scene_id']}/spectra.json")
                if sp:
                    check_spectra(sp, s, g, rep, spath)
            if s.get("status") == "mock":
                rep.warn(f"manifest scene {s['scene_id']}", "status is 'mock'. Replace with real data before the demo.")
        listed = {s.get("scene_id") for s in m.get("scenes", [])}
        scene_dir = os.path.join(data_dir, "scenes")
        if os.path.isdir(scene_dir):
            for d in sorted(os.listdir(scene_dir)):
                if d not in listed:
                    rep.warn("scenes/", f"folder '{d}' isn't listed in manifest.json (run update_manifest)")
    refs_path = os.path.join(data_dir, "references.json")
    if os.path.exists(refs_path):
        refs = load_json(refs_path, rep, "references.json")
        if refs:
            check_references(refs, rep)
    sites = load_json(os.path.join(data_dir, "sites.geojson"), rep, "sites.geojson")
    if sites:
        check_sites(sites, rep)

    print()
    for line in rep.fails + rep.warns:
        print(line)
    print()
    if rep.fails:
        print(f"FAIL: {len(rep.fails)} problem(s), {len(rep.warns)} warning(s)")
        return 1
    print(f"PASS: 0 problems, {len(rep.warns)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))

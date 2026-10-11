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
import sys

SUPPORTED_MAJOR = "1"
CLASS_KEYS = {0: "land", 1: "shallow", 2: "no_data", 3: "clear", 4: "weak_unclassified",
              5: "dense_unclassified", 6: "cp_like", 7: "noctiluca_like", 8: "diatom_like"}
RISK_TIER_KEYS = {"not_assessed", "none", "low", "monitor", "watch", "high"}
REFERENCES = {"cp": ("bloom", 6), "noctiluca_green": ("bloom", 7), "diatom": ("bloom", 8),
              "water_clear": ("water", 3), "water_turbid": ("water", 3), "seabed": ("water", 3)}
CLUSTER_LABELS = {"cp_like", "noctiluca_like", "diatom_like", "water", "unclassified"}
REGIONS = {"gulf": [51.2, 21.8, 60.79, 27.03], "oman": [56.0, 19.0, 63.0, 26.5]}
SENSORS = {"pace"}
ROLES = {"analysis_bloom", "analysis_calm", "held_out_test"}
STATUSES = {"mock", "real"}
SITE_TYPES = {"desalination", "aquaculture", "beach", "port", "other"}
SCENE_ID_RE = re.compile(r"^(gulf|oman)_(pace)_(\d{8})$")
SPECTRUM_UNITS = {"sr^-1", "normalized"}
MAX_CELLS = 600_000
MAX_GRID_MB = 15.0
MAX_SPECTRA_MB = 1.0

# Points that are clearly land or clearly sea. Used to catch upside-down grids.
ORIENTATION_POINTS = {
    "gulf": {"land": [(55.5, 24.4), (57.8, 23.2), (54.0, 26.9)], "sea": [(54.8, 25.6), (58.8, 24.6), (53.0, 26.0)]},
    "oman": {"land": [(57.5, 23.0), (58.5, 21.5), (56.2, 24.2)], "sea": [(58.0, 25.0), (60.0, 23.0), (62.0, 20.0)]},
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
    for k in ("chl_weak_min", "chl_dense_min", "nflh_dense_min", "margin_min", "shallow_max_m", "shallow_flag_max_m",
              "deriv_window", "deriv_polyorder"):
        if not is_num(rule.get(k)):
            rep.fail(w, f"rule.{k} must be a number")
    for k in ("sam_range_nm", "deriv_range_nm"):
        dr = rule.get(k)
        if not (isinstance(dr, list) and len(dr) == 2 and all(is_num(x) for x in dr) and dr[0] < dr[1]):
            rep.fail(w, f"rule.{k} must be [low, high] in nm")
    if is_num(rule.get("deriv_window")) and (rule["deriv_window"] % 2 != 1 or rule["deriv_window"] <= rule.get("deriv_polyorder", 0)):
        rep.fail(w, "rule.deriv_window must be odd and larger than rule.deriv_polyorder")
    if is_num(rule.get("shallow_max_m")) and is_num(rule.get("shallow_flag_max_m")) and rule["shallow_flag_max_m"] < rule["shallow_max_m"]:
        rep.fail(w, "rule.shallow_flag_max_m must be at least rule.shallow_max_m")
    if not isinstance(rule.get("nflh_units"), str) or not rule.get("nflh_units"):
        rep.fail(w, "rule.nflh_units must name the nflh units")
    if is_num(rule.get("chl_weak_min")) and is_num(rule.get("chl_dense_min")) and rule["chl_weak_min"] >= rule["chl_dense_min"]:
        rep.fail(w, "rule.chl_weak_min must be below rule.chl_dense_min")
    if rule.get("chl_units") != "mg m^-3":
        rep.fail(w, "rule.chl_units must be 'mg m^-3'")
    bands = rule.get("confidence_bands")
    if not (isinstance(bands, list) and bands and all(is_num(b.get("min")) and b.get("label") for b in bands)):
        rep.fail(w, "rule.confidence_bands must be a list of {key, label, min}")
    tiers = {t.get("key") for t in m.get("risk_tiers", [])}
    if tiers != RISK_TIER_KEYS:
        rep.fail(w, f"risk_tiers must have the keys {sorted(RISK_TIER_KEYS)}")
    codes = {c.get("code"): c.get("key") for c in m.get("classes", [])}
    if codes != CLASS_KEYS:
        rep.fail(w, f"classes must be exactly {CLASS_KEYS}")
    for c in m.get("classes", []):
        if c.get("risk_tier") not in RISK_TIER_KEYS:
            rep.fail(w, f"class {c.get('key')}: risk_tier must be one of {sorted(RISK_TIER_KEYS)}")
    for r, info in m.get("regions", {}).items():
        b = info.get("bbox")
        if r not in REGIONS or not (isinstance(b, list) and len(b) == 4 and all(is_num(x) for x in b)):
            rep.fail(w, f"regions.{r} must be a known region with a 4-number bbox")
            continue
        if any(abs(x - y) > 1e-6 for x, y in zip(b, REGIONS[r])):
            rep.fail(w, f"regions.{r}.bbox must be {REGIONS[r]}")
        if info.get("depth_file") not in (None, f"depth_{r}.json"):
            rep.fail(w, f"regions.{r}.depth_file must be null or 'depth_{r}.json'")
        elif not info.get("depth_file"):
            rep.warn(w, f"no depth_{r}.json, so the dashboard can't show depth or warn about shallow water "
                        f"where the seabed may show in that area. Write it once with write_depth().")
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
            rep.fail(sw, "scene_id must look like gulf_pace_20250324")
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
        if s.get("region") not in m.get("regions", {}):
            rep.fail(sw, f"its area '{s.get('region')}' isn't in regions")
        if s.get("status") == "real" and not s.get("products"):
            rep.warn(sw, "real scene without a products list")
        links = s.get("links", [])
        if not isinstance(links, list) or not all(
                isinstance(x, dict) and x.get("label") and str(x.get("url", "")).startswith(("http://", "https://")) for x in links):
            rep.fail(sw, "links must be a list of {label, url} with web addresses")


def check_references(refs, rep):
    w = "references.json"
    check_version(refs, rep, w)
    seen = set()
    for r in refs.get("references", []):
        rid = r.get("ref_id", "?")
        seen.add(rid)
        for k in ("ref_id", "label", "source", "group", "wavelengths_nm", "rrs"):
            if k not in r:
                rep.fail(w, f"{rid}: missing '{k}'")
        if rid in REFERENCES and r.get("group") != REFERENCES[rid][0]:
            rep.fail(w, f"{rid}: group must be '{REFERENCES[rid][0]}'")
        if len(r.get("wavelengths_nm", [])) != len(r.get("rrs", [])):
            rep.fail(w, f"{rid}: wavelengths_nm and rrs lengths differ")
        if r.get("units", "sr^-1") not in SPECTRUM_UNITS:
            rep.fail(w, f"{rid}: units must be one of {sorted(SPECTRUM_UNITS)}")
        if "placeholder" in (r.get("label", "") + r.get("source", "") + r.get("notes", "")).lower():
            rep.warn(w, f"{rid} is still a placeholder. Replace it with the real spectrum and its source before the demo.")
    if seen != set(REFERENCES):
        rep.fail(w, f"references must be exactly {sorted(REFERENCES)}")


def interp(src_wl, src, wl):
    """Linear interpolation of a spectrum onto wl; None outside its range or at missing values."""
    pts = [(x, y) for x, y in zip(src_wl, src) if is_num(x) and is_num(y)]
    out = []
    for t in wl:
        v = None
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x0 <= t <= x1:
                v = y0 if x1 == x0 else y0 + (y1 - y0) * (t - x0) / (x1 - x0)
                break
        out.append(v)
    return out


def shape_angle(a_wl, a, b_wl, b, lo, hi):
    """The shape comparison between two curves: degrees over lo-hi nm, b resampled onto a's bands."""
    pairs = [(x, y) for t, x, y in zip(a_wl, a, interp(b_wl, b, a_wl)) if lo <= t <= hi and is_num(x) and is_num(y)]
    if len(pairs) < 3:
        return None
    dot = sum(x * y for x, y in pairs)
    na, nb = math.sqrt(sum(x * x for x, _ in pairs)), math.sqrt(sum(y * y for _, y in pairs))
    return math.degrees(math.acos(max(-1.0, min(1.0, dot / (na * nb))))) if na and nb else None


def check_clusters(cl, rule, refs, rep):
    """Returns {cluster_id: cluster} when usable, else None."""
    w = "clusters.json"
    check_version(cl, rep, w)
    if cl.get("units") not in SPECTRUM_UNITS:
        rep.fail(w, f"units must be one of {sorted(SPECTRUM_UNITS)}")
    curves = {r.get("ref_id"): (r.get("wavelengths_nm", []), r.get("rrs", [])) for r in (refs or {}).get("references", [])}
    lo, hi = (rule.get("sam_range_nm") or [0, 10000])[:2]
    wl = cl.get("wavelengths_nm")
    if not (isinstance(wl, list) and wl and all(is_num(x) for x in wl)):
        rep.fail(w, "wavelengths_nm must be a non-empty list of numbers")
        return None
    if any(b <= a for a, b in zip(wl, wl[1:])):
        rep.fail(w, "wavelengths_nm must be strictly ascending")
    mmin = rule.get("margin_min", 0.25)
    out = {}
    for c in cl.get("clusters", []):
        cid = c.get("cluster_id")
        cw = f"{w} cluster {cid}"
        if not isinstance(cid, int) or cid in out:
            rep.fail(cw, "cluster_id must be a unique integer")
            continue
        out[cid] = c
        if len(c.get("mean_rrs", [])) != len(wl):
            rep.fail(cw, "mean_rrs length != wavelengths length")
        ang = c.get("sam_deg", {})
        if set(ang) != set(REFERENCES) or not all(is_num(v) and 0 <= v <= 90 for v in ang.values()):
            rep.fail(cw, f"sam_deg must give 0-90 degree angles for {sorted(REFERENCES)}")
            continue
        ranked = sorted(ang.values())
        best, second = c.get("best_ref"), c.get("second_ref")
        if best not in ang or second not in ang or best == second or ang[best] != ranked[0] or ang[second] != ranked[1]:
            rep.fail(cw, "best_ref/second_ref must be the references with the two smallest angles")
            continue
        gap = c.get("ref_gap_deg")
        if not (is_num(gap) and gap > 0):
            rep.fail(cw, "ref_gap_deg must be a positive angle")
            continue
        if best in curves and second in curves:
            actual = shape_angle(*curves[best], *curves[second], lo, hi)
            if actual is not None and abs(actual - gap) > 0.02:
                rep.fail(cw, f"ref_gap_deg {gap} isn't the angle between {best} and {second} in references.json ({actual:.2f})")
        expect_margin = min(1.0, max(0.0, (ang[second] - ang[best]) / gap))
        if not is_num(c.get("margin")) or abs(c["margin"] - expect_margin) > 0.011:
            rep.fail(cw, f"margin {c.get('margin')} doesn't match the angles and the reference gap ({expect_margin:.3f})")
            continue
        dang = c.get("sam_deriv_deg", {})
        if set(dang) != set(REFERENCES) or not all(is_num(v) and 0 <= v <= 180 for v in dang.values()):
            rep.fail(cw, f"sam_deriv_deg must give 0-180 degree angles for {sorted(REFERENCES)}")
            continue
        best_deriv = c.get("best_ref_deriv")
        if best_deriv not in dang or dang[best_deriv] != min(dang.values()):
            rep.fail(cw, "best_ref_deriv must be the reference with the smallest pigment-feature angle")
        group, _ = REFERENCES[best]
        expect_label = ("water" if group == "water" else
                        "unclassified" if c["margin"] < mmin or best_deriv != best else
                        {"cp": "cp_like", "noctiluca_green": "noctiluca_like", "diatom": "diatom_like"}[best])
        if c.get("label_key") != expect_label:
            rep.fail(cw, f"label_key '{c.get('label_key')}' should be '{expect_label}'")
    if not out:
        rep.fail(w, "no clusters listed")
    return out


def lookup(g, lon, lat):
    west, south, east, north = g["bbox"]
    if not (west <= lon < east and south < lat <= north):
        return None
    col = int((lon - west) / g["res_deg"][0])
    row = int((north - lat) / g["res_deg"][1])
    if 0 <= row < g["height"] and 0 <= col < g["width"]:
        return g["class_code"][row * g["width"] + col]
    return None


def expected_code(chl, nflh, cluster, rule):
    """Class for a pixel that passed the masks (codes 3-8). A null nflh is not raised."""
    group, species_code = REFERENCES[cluster["best_ref"]]
    if chl < rule["chl_weak_min"]:
        return 3
    dense = chl >= rule["chl_dense_min"] and is_num(nflh) and nflh >= rule["nflh_dense_min"]
    if not dense:
        return 3 if group == "water" else 4
    if group == "water" or cluster["margin"] < rule["margin_min"] or cluster.get("best_ref_deriv") != cluster["best_ref"]:
        return 5
    return species_code


def check_grid(g, scene, rule, regions, clusters, rep, path):
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
    if rb and any(abs(x - y) > 1e-6 for x, y in zip(b, rb)):
        rep.fail(w, f"bbox {b} must be the {scene.get('region')} area's box {rb}")

    n = W * H
    for name in ("class_code", "chlor_a", "nflh", "cluster_id"):
        a = g.get(name)
        if a is None:
            rep.fail(w, f"missing array '{name}'")
            return
        if not isinstance(a, list) or len(a) != n:
            rep.fail(w, f"'{name}' must be a flat list of width*height = {n} values (got {len(a) if isinstance(a, list) else type(a).__name__})")
            return
    codes, chl, fls, cids = g["class_code"], g["chlor_a"], g["nflh"], g["cluster_id"]
    if any(c not in CLASS_KEYS for c in codes):
        rep.fail(w, "class_code values must be 0-8 (null is not allowed here)")
        return

    nulls = unknown = negative = bad_nflh = big_nflh = 0
    wrong = {}
    water_chl = []
    for c, v, fl, k in zip(codes, chl, fls, cids):
        if fl is not None and not is_num(fl):
            bad_nflh += 1
        elif fl is not None and fl > 5:
            big_nflh += 1
        if v is not None and is_num(v) and v < 0:
            negative += 1
        if c < 3:
            continue
        if not (is_num(v) and isinstance(k, int)):
            nulls += 1
            continue
        if clusters is None:
            continue
        if k not in clusters:
            unknown += 1
            continue
        water_chl.append(v)
        e = expected_code(v, fl, clusters[k], rule)
        if e != c:
            wrong[c] = wrong.get(c, 0) + 1
    if nulls:
        rep.fail(w, f"{nulls} pixels with codes 3-8 have null chlor_a or cluster_id")
    if unknown:
        rep.fail(w, f"{unknown} pixels have a cluster_id that isn't in clusters.json")
    if negative:
        rep.fail(w, f"{negative} negative chlor_a values. Is this log10(chl)? Store mg m^-3.")
    if bad_nflh:
        rep.fail(w, f"{bad_nflh} nflh values aren't numbers or null")
    if big_nflh:
        rep.warn(w, f"{big_nflh} nflh values above 5. Is nflh in {rule.get('nflh_units')}?")
    for c, cnt in sorted(wrong.items()):
        rep.fail(w, f"{cnt} pixels with code {c} don't follow from chlor_a, nflh and their cluster. Use classify().")

    counts = {k: codes.count(k) for k in CLASS_KEYS}
    water = sum(counts[k] for k in range(3, 9))
    if water == 0:
        rep.warn(w, "no usable water pixels (codes 3-8) at all")
    elif water_chl and sum(1 for v in water_chl if v >= rule["chl_dense_min"]) / len(water_chl) > 0.5:
        rep.warn(w, "over half of the water is at or above the dense-bloom gate. Is chlor_a in mg m^-3?")

    for kind, pts in ORIENTATION_POINTS.get(scene.get("region"), {}).items():
        for lon, lat in pts:
            c = lookup(g, lon, lat)
            if c is None:
                continue
            if kind == "land" and c >= 3:
                rep.warn(w, f"({lon}, {lat}) is land but has water class {c}. Grid upside down (row 0 must be north)?")
            if kind == "sea" and c == 0:
                rep.warn(w, f"({lon}, {lat}) is sea but has class 0 (land). Grid upside down (row 0 must be north)?")

    mb = os.path.getsize(path) / 1e6
    if mb > MAX_GRID_MB:
        rep.warn(w, f"{mb:.1f} MB is over the {MAX_GRID_MB} MB guideline")
    share = ", ".join(f"{CLASS_KEYS[k]} {counts[k]}" for k in CLASS_KEYS if counts[k])
    print(f"  {sid}: {W}x{H} cells, {mb:.2f} MB  [{share}]")
    return g


def load_depths(m, data_dir, rep):
    """Each area's depth file the manifest names: {region: depth object} for the usable ones."""
    out = {}
    for r, info in m.get("regions", {}).items():
        if r in REGIONS and info.get("depth_file") == f"depth_{r}.json":
            d = load_depth(os.path.join(data_dir, info["depth_file"]), r, rep)
            if d:
                out[r] = d
    return out


def load_depth(path, region, rep):
    """One area's depth file. Returns the object when usable."""
    w = os.path.basename(path)
    d = load_json(path, rep, w)
    if not d:
        return None
    check_version(d, rep, w)
    b, r, W, H = d.get("bbox"), d.get("res_deg"), d.get("width"), d.get("height")
    vals = d.get("depth_m")
    if not (isinstance(b, list) and len(b) == 4 and isinstance(r, list) and len(r) == 2 and isinstance(W, int) and isinstance(H, int)):
        rep.fail(w, "needs bbox, res_deg, width and height like grid.json")
        return None
    if not isinstance(vals, list) or len(vals) != W * H:
        rep.fail(w, f"depth_m must be a flat list of width*height = {W * H} values")
        return None
    if any(abs(x - y) > 1e-6 for x, y in zip(b, REGIONS[region])):
        rep.fail(w, f"bbox must be the {region} area's box {REGIONS[region]}")
    nums = [v for v in vals if v is not None]
    if any(not is_num(v) for v in nums):
        rep.fail(w, "depth_m values must be numbers or null")
        return None
    neg = sum(1 for v in nums if v < 0)
    if nums and neg > len(nums) / 2:
        rep.warn(w, "most depths are negative. Is this GEBCO elevation? Store depth as positive metres below sea level.")
    elif neg:
        rep.fail(w, f"{neg} negative depths. Store depth as positive metres below sea level; null on land.")
    if d.get("units") != "m":
        rep.fail(w, "units must be 'm'")
    if "mock" in str(d.get("source", "")).lower():
        rep.warn(w, "depth is mock. Replace it with GEBCO on the same grid (write_depth) before the demo.")
    return d


def check_depth_agrees(depth, g, rule, rep):
    """
    Warn when shallow cells (code 1) and the area's depth file disagree. Shallow comes before
    the quality flags, so every water cell shallower than shallow_max_m is code 1; land is
    exempt. The depth may be null under shallow_max_m (the source left it out), not deeper.
    """
    if not depth or not g or any(depth.get(k) != g.get(k) for k in ("bbox", "res_deg", "width", "height")):
        if depth and g:
            rep.warn(f"{g.get('scene_id')}/grid.json", "grid differs from its area's depth file, so the dashboard can't show depth for it")
        return
    lim = rule.get("shallow_max_m")
    off = sum(
        1 for c, v in zip(g["class_code"], depth["depth_m"])
        if v is not None and ((c == 1 and v >= lim) or (c >= 2 and v < lim))
    )
    if off:
        rep.warn(f"{g['scene_id']}/grid.json", f"{off} cells disagree with the depth file about being shallower than {lim} m. Use shallow_mask(depth).")
    missing = sum(1 for c, v in zip(g["class_code"], depth["depth_m"]) if v is None and c >= 2)
    if missing:
        rep.warn(f"{g['scene_id']}/grid.json", f"{missing} water cells (codes 2-8) have no depth, so the dashboard can't flag shallow water there.")


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
            rep.fail(w, f"probe {pid}: class_code must be 0-8")
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


def check_sites(sites, rep):
    w = "sites.geojson"
    if sites.get("type") != "FeatureCollection":
        rep.fail(w, "must be a GeoJSON FeatureCollection")
        return
    ids = set()
    approx = []
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
        elif lat > 40 and lon < 40:
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
        if str(p.get("name", "")).startswith("Example "):
            rep.warn(w, f"{sid} is an example site. Replace it with a real location before the demo.")
        if "source" in p and not isinstance(p["source"], str):
            rep.fail(w, f"{sid}: source must be text")
        if p.get("source_url") is not None and not str(p["source_url"]).startswith(("http://", "https://")):
            rep.fail(w, f"{sid}: source_url must be a web address")
        if "approximate" in p and not isinstance(p["approximate"], bool):
            rep.fail(w, f"{sid}: approximate must be true or false")
        if p.get("approximate"):
            approx.append(sid)
    if approx:
        rep.warn(w, f"{len(approx)} sites have approximate locations ({', '.join(approx)}). Confirm them with the operators.")


def main(data_dir):
    rep = Report()
    print(f"Checking {os.path.abspath(data_dir)}")
    m = load_json(os.path.join(data_dir, "manifest.json"), rep, "manifest.json")
    refs = load_json(os.path.join(data_dir, "references.json"), rep, "references.json")
    if refs:
        check_references(refs, rep)
    clusters = None
    if m:
        check_manifest(m, rep)
        rule, regions = m.get("rule", {}), m.get("regions", {})
        depths = load_depths(m, data_dir, rep)
        cl = load_json(os.path.join(data_dir, "clusters.json"), rep, "clusters.json")
        if cl:
            clusters = check_clusters(cl, rule, refs, rep)
        for s in m.get("scenes", []):
            if not SCENE_ID_RE.match(s.get("scene_id", "")):
                continue
            gpath = os.path.join(data_dir, "scenes", s["scene_id"], "grid.json")
            g = load_json(gpath, rep, f"{s['scene_id']}/grid.json")
            g = check_grid(g, s, rule, regions, clusters, rep, gpath) if g else None
            check_depth_agrees(depths.get(s.get("region")), g, rule, rep)
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

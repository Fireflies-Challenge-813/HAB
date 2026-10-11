"""
import_map_export.py: turn the data team's map export into the contract files in data/.

    python pipeline/import_map_export.py <export folder> [--data <data folder>]

The export holds, for every date, <timestamp>_grid.tif: 8 float32 bands (label, chlor_a,
density_class, cluster, shallow_flag, depth, confidence, nflh), with NaN where empty. Shared
files: scenes.json, legend.json, cluster_spectra.json, references.json and summary.json.
The PNG and GeoJSON files in it are previews and aren't needed.

Every class is the data team's. The script recomputes the cluster angles, the margin and
every pixel's class with export_contract.py, and stops if anything disagrees with the export,
so the contract files can't drift from the pipeline that made them.

One adjustment: a value that sits within one display step of a threshold (chlorophyll
4.997 for a pixel the pipeline put below 5) is stored on the side the pipeline decided
(4.99), so the number the dashboard shows and the class agree. The class never changes;
the script prints how many values it adjusted.

Requires: numpy. The GeoTIFFs are read with zlib, without GDAL.
"""

import json
import os
import re
import shutil
import struct
import sys
import zlib

import numpy as np

import export_contract as ec

BANDS = ["label", "chlor_a", "density_class", "cluster", "shallow_flag", "depth", "confidence", "nflh"]
# The export's label codes -> contract class codes (DATA_CONTRACT.md section 6).
LABEL_NAMES = {-1: "Land", 0: "No data", 1: "Excluded: very shallow", 2: "Non-bloom water", 3: "Weak bloom",
               4: "Unclassified dense bloom", 5: "C. polykrikoides-like", 6: "Green Noctiluca-like", 7: "Diatom-like"}
TO_CODE = {-1: 0, 0: 2, 1: 1, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8}
REF_IDS = {"C. polykrikoides": "cp", "Green Noctiluca": "noctiluca_green", "Diatom": "diatom",
           "Clear water": "water_clear", "Turbid water": "water_turbid", "Shallow seabed": "seabed"}
CLUSTER_LABELS = {"Clear water": "water", "Turbid water": "water", "Shallow seabed": "water",
                  "Unclassified": "unclassified", "C. polykrikoides-like": "cp_like",
                  "Green Noctiluca-like": "noctiluca_like", "Diatom-like": "diatom_like"}
ROLES = {"analysis": "analysis_bloom", "calm": "analysis_calm", "test": "held_out_test"}
PRODUCTS = ["PACE_OCI_L2_AOP", "PACE_OCI_L2_BGC", "PACE_OCI_L2_IOP"]
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


class ExportError(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise ExportError(msg)


# --- GeoTIFF ----------------------------------------------------------------------
def read_geotiff(path):
    """
    Read a strip-organised, pixel-interleaved float32 GeoTIFF (deflate or uncompressed).
    Returns (array (H, W, bands), band names, bbox [west, south, east, north], res [lon, lat]).
    """
    with open(path, "rb") as f:
        b = f.read()
    e = {b"II": "<", b"MM": ">"}.get(b[:2])
    need(e and struct.unpack(e + "H", b[2:4])[0] == 42, f"{path}: not a classic TIFF file")
    off = struct.unpack(e + "I", b[4:8])[0]
    n = struct.unpack(e + "H", b[off:off + 2])[0]
    size = {1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8}
    fmt = {1: "B", 2: "s", 3: "H", 4: "I", 11: "f", 12: "d", 16: "Q"}
    tags = {}
    for i in range(n):
        tag, typ, cnt, val = struct.unpack(e + "HHI4s", b[off + 2 + 12 * i: off + 14 + 12 * i])
        nbytes = size.get(typ, 1) * cnt
        raw = (val if nbytes <= 4 else b[struct.unpack(e + "I", val)[0]:])[:nbytes]
        tags[tag] = raw.rstrip(b"\0").decode("latin1") if typ == 2 else struct.unpack(e + fmt.get(typ, "B") * cnt, raw)
    W, H, spp = tags[256][0], tags[257][0], tags.get(277, (1,))[0]
    need(273 in tags, f"{path}: tiled TIFFs aren't supported (expected strips)")
    need(set(tags[258]) == {32} and set(tags.get(339, (1,))) == {3}, f"{path}: bands must be 32-bit floats")
    need(tags[259][0] in (1, 8, 32946), f"{path}: compression {tags[259][0]} isn't supported (deflate or none)")
    need(tags.get(284, (1,))[0] == 1 or spp == 1, f"{path}: bands must be pixel-interleaved")
    need(tags.get(317, (1,))[0] == 1, f"{path}: predictors aren't supported")
    keys = tags.get(34735, ())
    geo = {keys[i]: keys[i + 3] for i in range(4, len(keys), 4)}
    need(geo.get(2048) == 4326, f"{path}: the grid must be EPSG:4326 longitude/latitude")
    need(geo.get(1025, 1) == 1, f"{path}: the grid must be pixel-is-area")
    chunks = [b[o:o + c] for o, c in zip(tags[273], tags[279])]
    data = b"".join(zlib.decompress(c) if tags[259][0] != 1 else c for c in chunks)
    a = np.frombuffer(data, dtype=e + "f4").reshape(H, W, spp)
    names = re.findall(r'<Item name="DESCRIPTION" sample="\d+" role="description">([^<]*)</Item>', tags.get(42112, ""))
    sx, sy = tags[33550][:2]
    west, north = tags[33922][3], tags[33922][4]
    return a, names, [west, north - H * sy, west + W * sx, north], [sx, sy]


# --- helpers ------------------------------------------------------------------------
def load_json(folder, name):
    path = os.path.join(folder, name)
    need(os.path.exists(path), f"{name} is missing from the export folder")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def region_of(bounds):
    """The contract area whose box is these Leaflet-order bounds [[south, west], [north, east]]."""
    (s, w), (n, e) = bounds
    for key, info in ec.REGIONS.items():
        if all(abs(a - b) < 1e-6 for a, b in zip([w, s, e, n], info["bbox"])):
            return key
    raise ExportError(f"no area in export_contract.REGIONS has the box {[w, s, e, n]}; add it there first")


def fmt_date(iso):
    y, m, d = iso.split("-")
    return f"{int(d)} {MONTHS[int(m) - 1]} {y}"


def nudge(values, wrong, threshold, step, target, what, sid):
    """Store `values` at `target` where `wrong`, if each is within one display step of the threshold; else stop."""
    far = wrong & (np.abs(values - threshold) > step + 1e-9)
    need(not far.any(), f"{sid}: {int(far.sum())} pixels' {what} contradict their class by more than one display step")
    return np.where(wrong, target, values), int(wrong.sum())


# --- references and clusters -------------------------------------------------------
def import_references(ex):
    wl = np.asarray(ex["wavelengths_nm"], dtype=float)
    need(set(ex["references"]) == set(REF_IDS), f"references.json must hold exactly {sorted(REF_IDS)}")
    refs = {}
    for name, r in ex["references"].items():
        rid = REF_IDS[name]
        need((r["kind"] == "species") == (ec.REFERENCES[rid]["group"] == "bloom"), f"reference {name}: kind {r['kind']} doesn't match its group")
        refs[rid] = {
            "ref_id": rid,
            "label": name,
            "source": r["source"],
            "source_url": None,
            "units": "normalized",
            "wavelengths_nm": [round(float(w), 2) for w in wl],
            "rrs": [round(float(v), 5) for v in r["values"]],
            "notes": f"Region: {r['region']}. Curve scaled to unit length. The shape comparison uses "
                     f"{ec.RULE['sam_range_nm'][0]:.0f}-{ec.RULE['sam_range_nm'][1]:.0f} nm of it.",
        }
    return wl, refs


def import_clusters(ex, wl, refs):
    need(np.allclose(ex["wavelengths_nm"], wl), "cluster_spectra.json and references.json use different wavelengths")
    curves = {rid: (wl, np.asarray(r["rrs"], dtype=float)) for rid, r in refs.items()}
    gaps = ec.reference_gaps(curves)
    clusters, dense_curves = [], 0
    for key, x in sorted(ex["clusters"].items(), key=lambda kv: int(kv[0])):
        cid = int(key)
        spec = np.asarray(x["spectrum"], dtype=float)
        angles = {rid: ec.spectral_angle_deg(spec, c, wl, w) for rid, (w, c) in curves.items()}
        deriv = {rid: ec.spectral_angle_deriv_deg(spec, c, wl, w) for rid, (w, c) in curves.items()}
        rec = ec.cluster_record(cid, spec, angles, n_pixels=x["pixels"], parent_id=None, sam_deriv_deg=deriv, ref_gaps=gaps)
        best, second = REF_IDS[x["best"]], REF_IDS[x["runner_up"]]
        checks = [
            (rec["best_ref"] == best and rec["second_ref"] == second, f"best/runner-up {rec['best_ref']}/{rec['second_ref']}, export {best}/{second}"),
            (abs(angles[best] - x["angle_best_deg"]) <= 0.01, f"angle to best {angles[best]:.3f}, export {x['angle_best_deg']}"),
            (abs(angles[second] - x["angle_runner_up_deg"]) <= 0.01, f"angle to runner-up {angles[second]:.3f}, export {x['angle_runner_up_deg']}"),
            (abs(gaps[(best, second)] - x["reference_gap_deg"]) <= 0.01, f"reference gap {gaps[(best, second)]:.3f}, export {x['reference_gap_deg']}"),
            (rec["best_ref_deriv"] == REF_IDS[x["derivative_best"]], f"pigment best {rec['best_ref_deriv']}, export {x['derivative_best']}"),
            (abs(rec["margin"] - x["confidence"]) < 0.005, f"margin {rec['margin']}, export confidence {x['confidence']}"),
            (rec["label_key"] == CLUSTER_LABELS[x["cluster_name"]], f"label {rec['label_key']}, export {x['cluster_name']}"),
        ]
        for ok, msg in checks:
            need(ok, f"cluster {cid}: {msg}")
        dense_curves += x.get("spectrum_from") == "dense"
        clusters.append(rec)
    return clusters, dense_curves


# --- one date ------------------------------------------------------------------------
def import_scene(folder, s, region, clusters, data_dir, rule=ec.RULE):
    sid = f"{region}_pace_{s['date'].replace('-', '')}"
    a, names, bbox, res = read_geotiff(os.path.join(folder, s["files"]["grid"]))
    need(names == BANDS, f"{s['files']['grid']}: bands are {names}, expected {BANDS}")
    # The export stores the cell size as a float32 (0.0099983 for 0.01), so check the corner,
    # the cell size and the cell count rather than the far edges.
    box = ec.REGIONS[region]["bbox"]
    size = (round((box[2] - box[0]) / 0.01), round((box[3] - box[1]) / 0.01))
    need(abs(bbox[0] - box[0]) < 1e-4 and abs(bbox[3] - box[3]) < 1e-4 and all(abs(r - 0.01) < 1e-5 for r in res)
         and (a.shape[1], a.shape[0]) == size,
         f"{s['files']['grid']}: the grid (corner {bbox[0]:.4f}, {bbox[3]:.4f}, {a.shape[1]}x{a.shape[0]} cells of {res[0]:.6f} deg) "
         f"isn't the {region} box at 0.01 deg")
    lab = a[..., 0].astype(int)
    chl, dens, cl = (a[..., k].astype(float) for k in (1, 2, 3))
    depth, conf, nf = (a[..., k].astype(float) for k in (5, 6, 7))
    need(set(np.unique(lab).tolist()) <= set(TO_CODE), f"{sid}: unknown label codes")
    code = np.vectorize(TO_CODE.get)(lab)
    water = code >= 3

    # Values the contract keeps only on assessed water (codes 3-8).
    need(not np.any(water & ~(np.isfinite(chl) & np.isfinite(nf) & (cl >= 0))), f"{sid}: assessed pixels without chlorophyll, nflh or cluster")
    chl = np.where(water, chl, np.nan)
    nf = np.where(water, nf, np.nan)
    cl = np.where(water, cl, np.nan)
    nf = np.where(water & (nf < 0) & (np.round(nf, ec.DECIMALS["nflh"]) == 0), 0.0, nf)  # no "-0.0000"

    # Store values within one display step of a threshold on the side the pipeline decided.
    step_c, step_f = 10.0 ** -ec.DECIMALS["chlor_a"], 10.0 ** -ec.DECIMALS["nflh"]
    weak_min, dense_min, nflh_min = rule["chl_weak_min"], rule["chl_dense_min"], rule["nflh_dense_min"]
    adjusted = 0
    rc = lambda: np.round(chl, ec.DECIMALS["chlor_a"])
    rf = lambda: np.round(nf, ec.DECIMALS["nflh"])
    chl, k = nudge(chl, water & (dens == 0) & (rc() >= weak_min), weak_min, step_c, weak_min - step_c, "chlorophyll", sid); adjusted += k
    chl, k = nudge(chl, water & (dens >= 1) & (rc() < weak_min), weak_min, step_c, weak_min, "chlorophyll", sid); adjusted += k
    chl, k = nudge(chl, water & (dens == 2) & (rc() < dense_min), dense_min, step_c, dense_min, "chlorophyll", sid); adjusted += k
    nf, k = nudge(nf, water & (dens == 2) & (rf() < nflh_min), nflh_min, step_f, nflh_min, "nflh", sid); adjusted += k
    looks_dense = water & (dens == 1) & (rc() >= dense_min) & (rf() >= nflh_min)
    chl, k = nudge(chl, looks_dense & (chl < dense_min), dense_min, step_c, dense_min - step_c, "chlorophyll", sid); adjusted += k
    looks_dense = water & (dens == 1) & (rc() >= dense_min) & (rf() >= nflh_min)
    nf, k = nudge(nf, looks_dense, nflh_min, step_f, nflh_min - step_f, "nflh", sid); adjusted += k

    # Every class must follow from the stored values, the cluster table and the masks.
    again = ec.classify(chl, cl, clusters, lab == -1, lab == 0, lab == 1, nflh=nf, rule=rule)
    wrong = again != code
    need(not wrong.any(), f"{sid}: {int(wrong.sum())} pixels' classes don't follow from their values "
                          f"(export {np.unique(code[wrong])[:5].tolist()}, recomputed {np.unique(again[wrong])[:5].tolist()})")
    margin = {c["cluster_id"]: c["margin"] for c in clusters}
    has_conf = np.isfinite(conf)
    need(np.array_equal(has_conf, np.isin(code, (6, 7, 8))), f"{sid}: confidence isn't exactly on the named pixels")
    need(all(abs(conf[i] - margin[int(cl[i])]) < 0.005 for i in zip(*np.nonzero(has_conf))), f"{sid}: pixel confidence differs from its cluster's")
    flag = ec.shallow_flag(depth) & water
    need(np.array_equal(flag, (a[..., 4] == 1) & water), f"{sid}: the shallow flag doesn't follow from the depth")
    need(not np.any(water & ~np.isfinite(depth)), f"{sid}: assessed water without a depth")
    need(not np.any((lab == 1) & np.isfinite(depth) & (depth >= rule["shallow_max_m"])), f"{sid}: very shallow cells deeper than {rule['shallow_max_m']} m")

    ec.write_grid(data_dir, sid, box, [0.01, 0.01], code, chl, cl, clusters, nflh=nf)
    counts = {c["key"]: int(np.sum(code == c["code"])) for c in ec.CLASSES}
    expected = {TO_CODE[k]: v for k, v in ((k, s["label_counts"][LABEL_NAMES[k]]) for k in range(0, 8))}
    need(all(counts[ec.CLASSES[c]["key"]] == v for c, v in expected.items()), f"{sid}: class counts differ from scenes.json")
    return sid, np.where(lab == -1, np.nan, depth), adjusted, counts


def scene_text(s, summary):
    role = ROLES[s["role"]]
    note = re.sub(r"^Test date:\s*", "", s.get("note", "")).strip()
    note = note[:1].upper() + note[1:]
    if role == "held_out_test":
        t = summary["test"]
        pct = t["percent_of_dense"]
        result = (f"Result: of {t['dense_pixels']:,} dense-bloom pixels, {pct['Green Noctiluca-like']:g}% are Noctiluca-like, "
                  f"{pct['Unclassified dense bloom']:g}% unclassified and {pct['C. polykrikoides-like']:g}% C. polykrikoides-like. "
                  f"The false-alarm check (under 10% C. polykrikoides-like, most Noctiluca-like or unclassified): "
                  f"{'passed' if t['result'] == 'PASS' else 'failed'}.")
        return f"Held-out test, {fmt_date(s['date'])}", f"{note} {result}".strip()
    if role == "analysis_calm":
        return "Analysis date (calm water)", f"{note or 'Low-bloom reference date.'} Pooled into the k-means fit so it learns normal water."
    return "Analysis date (bloom season)", note or "Bloom-season date pooled into the k-means fit."


# --- main ---------------------------------------------------------------------------
def remove_mock(data_dir):
    """Remove the mock scenes and the files only mock data has. Real scenes are kept."""
    path = os.path.join(data_dir, "manifest.json")
    keep = []
    if os.path.exists(path):
        with open(path) as f:
            scenes = json.load(f).get("scenes", [])
        for s in scenes:
            if s.get("status") == "real":
                keep.append(s)
            else:
                shutil.rmtree(os.path.join(data_dir, "scenes", s.get("scene_id", "")), ignore_errors=True)
    for name in ("depth.json",):  # the single depth file of the old layout
        if os.path.exists(os.path.join(data_dir, name)):
            os.remove(os.path.join(data_dir, name))
    return keep


def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__)
        return 2
    folder = argv[0]
    data_dir = argv[argv.index("--data") + 1] if "--data" in argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

    scenes = load_json(folder, "scenes.json")
    legend = load_json(folder, "legend.json")
    summary = load_json(folder, "summary.json")
    need({x["code"]: x["name"] for x in legend} == LABEL_NAMES, "legend.json's codes and names aren't the ones this script maps")
    th, rule = summary["thresholds"], ec.RULE
    need(th["chl_weak_mg_m3"] == rule["chl_weak_min"] and th["chl_dense_mg_m3"] == rule["chl_dense_min"]
         and th["nflh_raised_W_m2_um_sr"] == rule["nflh_dense_min"] and th["margin_min"] == rule["margin_min"]
         and th["depth_excluded_below_m"] == rule["shallow_max_m"] and th["depth_flagged_below_m"] == rule["shallow_flag_max_m"]
         and th["main_comparison_nm"][0] == rule["sam_range_nm"][0], "summary.json's thresholds differ from export_contract.RULE")
    need(scenes.get("nflh_units") == rule["nflh_units"], "scenes.json's nflh units differ from RULE['nflh_units']")

    wl, refs = import_references(load_json(folder, "references.json"))
    clusters, dense_curves = import_clusters(load_json(folder, "cluster_spectra.json"), wl, refs)

    keep = remove_mock(data_dir)
    ec.write_manifest(data_dir, keep)
    ec.write_references(data_dir, [refs[r] for r in ec.REFERENCES])

    method = summary["method"]
    k = [int(v) for v in re.findall(r"(\d+)\s*(?:coarse|fine)", method["kmeans"])]
    fit_dates = sorted(s["date"] for s in scenes["scenes"] if s["role"] != "test")
    ec.write_clusters(data_dir, wl, clusters, {
        "dates": fit_dates,
        "k_coarse": k[0],
        "k_fine": len(clusters),
        "pca_components": method["pca_components"],
        "notes": (f"Two-level k-means ({method['kmeans']}) on PCA-compressed spectra ({method['pca_components']} components, "
                  f"{100 * method['pca_variance_explained']:.2f}% of the variation), fitted on the pooled analysis dates. "
                  f"Curves are scaled to unit length; for {dense_curves} clusters the curve is the mean of their dense pixels."),
    }, units="normalized")

    depths, total_adjusted = {}, 0
    for s in sorted(scenes["scenes"], key=lambda s: s["date"]):
        region = region_of(s["bounds"])
        sid, depth, adjusted, counts = import_scene(folder, s, region, clusters, data_dir)
        total_adjusted += adjusted
        if region in depths:
            need(np.array_equal(depths[region], depth, equal_nan=True), f"{sid}: depth differs from the area's other dates")
        depths[region] = depth
        title, context = scene_text(s, summary)
        links = [{"label": k, "url": v} for k, v in s.get("links", {}).items()]
        nasa = next((l["url"] for l in links if "nasa" in l["url"]), None)
        ec.update_manifest(data_dir, {"scene_id": sid, "role": ROLES[s["role"]], "status": "real", "title": title,
                                      "context": context, "source_url": nasa, "links": links, "products": PRODUCTS})
        print(f"  {sid}: " + ", ".join(f"{k} {v}" for k, v in counts.items() if v) + (f"; {adjusted} values set to their class's side of a threshold" if adjusted else ""))
    for region, depth in depths.items():
        ec.write_depth(data_dir, region, ec.REGIONS[region]["bbox"], [0.01, 0.01], depth,
                       source="The data team's export: GEBCO depth on the 0.01 deg grid, left out under 5 m")
    ec.write_manifest(data_dir, json.load(open(os.path.join(data_dir, "manifest.json")))["scenes"])  # names the depth files
    print(f"done: {len(scenes['scenes'])} dates, {len(clusters)} clusters, {total_adjusted} values adjusted at thresholds")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ExportError as err:
        print(f"STOPPED: {err}")
        sys.exit(1)

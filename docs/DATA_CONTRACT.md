# Data contract: Gulf Bloom Watch

**Contract version 1.0**

This is the single agreement between the data team (pipeline) and the interface (dashboard). If a file, field name, unit or code isn't written here, it doesn't exist yet. If anything here changes, bump `contract_version` and tell the whole team the same day (section 11).

---

## 1. Agree on these eight things first

- [ ] **Scene list and IDs** (section 4)
- [ ] **Grid layout:** a regular lat/lon grid, with row 0 = north and column 0 = west (section 5)
- [ ] **Class codes 0–5** and what decides each one (section 6)
- [ ] **Units:** Rrs in sr⁻¹; nFLH in **mW cm⁻² µm⁻¹ sr⁻¹** (section 7)
- [ ] **Thresholds:** they live in `manifest.json`, written by the pipeline. The dashboard never hard-codes them (section 7)
- [ ] **Bands:** the bands actually used are logged per scene, especially the fluorescence baseline on PACE (section 7)
- [ ] **Spectra:** which probe pixels and which reference spectra (section 8)
- [ ] **Folder ownership,** and running the validator before every push (sections 2 and 10)

---

## 2. Who owns what

| Path | Owner | Written by |
|---|---|---|
| `data/manifest.json` | Data team | `update_manifest()` (never edit by hand) |
| `data/scenes/<scene_id>/grid.json` | Data team | `write_grid()` |
| `data/scenes/<scene_id>/spectra.json` | Data team | `write_spectra()` |
| `data/references.json` | Data team | `write_references()` |
| `data/sites.geojson` | Interface | By hand |
| The web app (wherever it lives in the repo) | Interface | |
| `pipeline/` | Data team | Helpers provided |

All the helper functions are in `pipeline/export_contract.py`. Use them rather than writing JSON by hand, so names, orientation and units can't drift.

---

## 3. Folder layout (data side)

```
data/
├── manifest.json            ← scenes + rule thresholds + class labels + regions
├── references.json          ← reference spectra (e.g. Korean C. polykrikoides)
├── sites.geojson            ← watched sites (interface-owned)
└── scenes/
    └── <scene_id>/
        ├── grid.json        ← class + values for every pixel (required)
        └── spectra.json     ← sample spectra for the chart (optional, recommended)
pipeline/
├── export_contract.py       ← writes every data file in this exact format
├── validate_contract.py     ← checks data/ against this contract (stdlib only)
└── make_mock_data.py        ← mock data, generated through export_contract.py
```

The web app reads `data/` over HTTP. Where the web app's own code lives is up to the interface.

---

## 4. Scenes and IDs

A **scene** is one satellite image, from one sensor, of one region, on one date.

**`scene_id` format:** `{region}_{sensor}_{YYYYMMDD}`, all lowercase. Examples: `gulf_pace_20250308`, `korea_pace_20260810`.

| Field | Allowed values |
|---|---|
| `region` | `gulf` (Arabian Gulf + Sea of Oman), `korea` (Korean south coast, test site) |
| `sensor` | `pace`, `modis` |
| `role` | `true_positive_test`, `probable_negative_test`, `implementation_check`, `monitoring` |
| `status` | `mock` (generated placeholder) or `real` (pipeline output) |

**Region boxes** (`[west, south, east, north]`, in degrees). A scene may cover a smaller box inside its region, but never a bigger one.

| Region | Box |
|---|---|
| `gulf` | `[47.5, 22.0, 60.0, 30.5]` |
| `korea` | `[125.5, 33.0, 130.5, 36.0]` |

**Planned scenes.** The data team fills in the real dates once they pick the clearest images.

| scene_id | Role | Why |
|---|---|---|
| `korea_pace_2026MMDD` | `true_positive_test` | NIFS "Caution" alert for *M. polykrikoides*, South Sea coast, August 2026 |
| `gulf_pace_20250308` | `probable_negative_test` | NASA: swirls that likely include *Noctiluca*. We should *not* flag *C. polykrikoides* here |
| `gulf_modis_2008MMDD` (1–2 dates) | `implementation_check` | Reproduce Ghanea et al. (2016) on the 2008 bloom |
| `gulf_pace_YYYYMMDD` | `monitoring` | Recent clear Gulf scenes, shown as unvalidated |

The mock data uses `korea_pace_20260810`, `gulf_pace_20250308`, `gulf_modis_20081020` and `gulf_modis_20081215`. A real scene with the same ID overwrites the mock one.

---

## 5. `grid.json`, the main file (one per scene)

### Grid layout

- The grid is a **regular latitude/longitude grid** (EPSG:4326) with constant spacing.
- `bbox` = `[west, south, east, north]` = the **outer edges** of the grid, not the centers of the edge cells.
- `res_deg` = `[res_lon, res_lat]`, both positive.
- `width` = number of columns = `(east − west) / res_lon`. `height` = number of rows = `(north − south) / res_lat`.
- Every array is **flat and row-major**, with **row 0 = the northernmost row** and **column 0 = the westernmost column**.
  `index = row * width + col`
- Cell center: `lon = west + (col + 0.5) * res_lon`, `lat = north − (row + 0.5) * res_lat`
- Missing value = `null`. Never `NaN`, `-999` or `0`.

> **Most common bug:** netCDF/xarray latitude usually runs south → north, so the map comes out upside down. `orient_grid()` detects this and flips it, and the validator warns if land and sea look swapped.

### Example (shortened)

```json
{
  "contract_version": "1.0",
  "scene_id": "gulf_pace_20250308",
  "bbox": [47.5, 22.0, 60.0, 30.5],
  "res_deg": [0.041667, 0.041667],
  "width": 300,
  "height": 204,
  "class_code":    [0, 0, 3, 3, 4, 5, 1],
  "ratio_667_443": [null, null, 0.412, 0.398, 0.81, 1.243, null],
  "nflh":          [null, null, 0.0112, 0.0098, 0.0634, 0.0712, null],
  "sam_deg":       [null, null, 31.2, 29.8, 14.1, 6.2, null]
}
```

### Fields

| Field | Type | Required | Units | Decimals | Notes |
|---|---|---|---|---|---|
| `contract_version` | string | yes | | | `"1.0"` |
| `scene_id` | string | yes | | | Must match the folder name |
| `bbox` | 4 numbers | yes | degrees | | Outer edges |
| `res_deg` | 2 numbers | yes | degrees | | `[res_lon, res_lat]` |
| `width`, `height` | integers | yes | | | Columns, rows |
| `class_code` | int array | yes | | | Codes 0–5 (section 6). Never null |
| `ratio_667_443` | float array | yes | none | 3 | Rrs(667)/Rrs(443) |
| `nflh` | float array | yes | mW cm⁻² µm⁻¹ sr⁻¹ | 4 | Normalized fluorescence line height |
| `sam_deg` | float array | no | degrees | 1 | Spectral angle to the *C. polykrikoides* reference (PACE only). Supporting evidence only; never changes the class |

**Size limits:** `width × height ≤ 250,000` and file ≤ 6 MB. The Gulf box at PACE Level-3 4 km (1/24°) is 300 × 204 = 61,200 cells. For 1 km work, use a smaller box.

---

## 6. Class codes (fixed)

| Code | Key | Label | When |
|---|---|---|---|
| 0 | `land` | Land | Land mask |
| 1 | `no_data` | No data | Cloud, dust, failed quality flags, or Rrs missing at a needed band |
| 2 | `shallow` | Shallow water (masked) | Depth shallower than `shallow_max_m` (seabed may show through) |
| 3 | `clear` | Water, no bloom | `nflh ≤ nflh_min` |
| 4 | `bloom_other` | Bloom, not *C. polykrikoides*-like | `nflh > nflh_min` and `ratio ≤ ratio_min` |
| 5 | `cp_like` | *C. polykrikoides*-like bloom | `nflh > nflh_min` and `ratio > ratio_min` |

**Precedence:** land beats no_data, no_data beats shallow, and shallow beats the rule. Use `classify()` so the order is always the same.

For codes 3–5, `ratio_667_443` and `nflh` must not be null. For codes 0–2 they may be null.

---

## 7. The rule, units and band logging

**The rule** (Ghanea, Moradi and Kabiri, 2016, *Advances in Space Research* 58(7)): a pixel is *C. polykrikoides*-like when **Rrs(667)/Rrs(443) > 1** and **nFLH > 0.04 mW cm⁻² µm⁻¹ sr⁻¹**.

**How to compute it** (`compute_rule_inputs()` does this, using the nearest available bands):

```
ratio_667_443 = Rrs(667) / Rrs(443)

nLw(λ)  = Rrs(λ) × F0(λ)         Rrs in sr⁻¹, F0 in mW cm⁻² µm⁻¹  →  nLw in mW cm⁻² µm⁻¹ sr⁻¹
nflh    = nLw(678) − [ nLw(667) + (nLw(hi) − nLw(667)) × (678 − 667) / (hi − 667) ]
```

> **Units trap.** NASA's ready-made nflh products are in **W m⁻² µm⁻¹ sr⁻¹**, and 1 mW cm⁻² = 10 W m⁻². To use a NASA nflh value here, **divide it by 10**. The validator warns when values look 10× off.

> **PACE trap.** MODIS uses `hi = 748 nm`, but standard PACE Rrs stops at about 719 nm (and version-3 files leave out 590–610 nm). On PACE either:
> (a) use the longest available band (about 717–719 nm) as `hi`, or
> (b) generate modeled Rrs at 748 nm with `l2gen`.
> Log the choice in `bands_used_nm`.

> **Rounding.** `classify()` compares values **rounded to the stored decimals**, so a stored ratio of 1.000 is never class 5. If you classify any other way, round first.

**Where the numbers live.** The `rule` block in `manifest.json` is written by the pipeline from `RULE` in `export_contract.py`. The dashboard reads the thresholds from there.

```json
"rule": {
  "name": "Ghanea, Moradi & Kabiri (2016) MODIS rule, computed on PACE",
  "citation": "Ghanea, M., Moradi, M., Kabiri, K. (2016). A novel method for characterizing harmful algal blooms in the Persian Gulf using MODIS measurements. Advances in Space Research 58(7), 1348-1361.",
  "citation_url": "https://www.sciencedirect.com/science/article/abs/pii/S0273117716302848",
  "ratio_name": "Rrs(667)/Rrs(443)",
  "ratio_min": 1.0,
  "nflh_min": 0.04,
  "nflh_units": "mW cm^-2 um^-1 sr^-1",
  "shallow_max_m": 10.0,
  "sam_max_deg": 10.0
}
```

`shallow_max_m` (10 m) is a team decision that's still open. `sam_max_deg` is for display only.

**Per-scene band log** (in `manifest.json`; `compute_rule_inputs()` returns it):

```json
"bands_used_nm": {"ratio_num": 667.5, "ratio_den": 442.5, "flh_peak": 677.5, "flh_base_low": 667.5, "flh_base_high": 717.5},
"f0_source": "Where the F0 values came from"
```

---

## 8. Spectra: `spectra.json` (per scene) and `references.json`

These feed the spectrum chart. They're optional, but they're the visible hyperspectral showcase, so try to include them.

**`data/scenes/<scene_id>/spectra.json`**

```json
{
  "contract_version": "1.0",
  "scene_id": "gulf_pace_20250308",
  "units": "sr^-1",
  "wavelengths_nm": [400.0, 405.0, 410.0],
  "probes": [
    {"probe_id": "p01", "lon": 58.31, "lat": 24.71, "class_code": 4, "rrs": [0.0021, 0.0023, 0.0024]}
  ],
  "class_means": {"3": [0.0071, 0.0069, 0.0066], "4": [0.0024, 0.0025, 0.0025], "5": [0.0016, 0.0016, 0.0017]}
}
```

- `wavelengths_nm` is strictly ascending. Leave out bands you don't have; don't fill them with zeros.
- Each `rrs` array and each `class_means` array has the same length as `wavelengths_nm`. `null` is allowed inside them.
- **Probes** are 10–50 pixels: the strongest `cp_like`, some `bloom_other`, some `clear`, and ideally one near each watched site. `pick_probes()` does this automatically.
- `class_means` holds the mean Rrs of each class over the scene. Keys are class codes as strings.
- Keep the file ≤ 1 MB.

**`data/references.json`**

```json
{
  "contract_version": "1.0",
  "references": [
    {"ref_id": "cp_korea", "label": "C. polykrikoides (Korean field measurement)",
     "source": "Full citation", "source_url": "https://...",
     "units": "sr^-1", "wavelengths_nm": [400, 405], "rrs": [0.0012, 0.0012],
     "notes": "Bloom density, date, how it was measured"}
  ]
}
```

References keep their own wavelengths. Resampling to scene bands (for `sam_deg`) happens in the pipeline.

---

## 9. `manifest.json`

The manifest is generated by `update_manifest()`. This is the full shape:

```json
{
  "contract_version": "1.0",
  "generated_utc": "2026-10-06T12:00:00Z",
  "rule": {"...": "section 7"},
  "classes": [
    {"code": 0, "key": "land", "label": "Land"},
    {"code": 1, "key": "no_data", "label": "No data"},
    {"code": 2, "key": "shallow", "label": "Shallow water (masked)"},
    {"code": 3, "key": "clear", "label": "Water, no bloom"},
    {"code": 4, "key": "bloom_other", "label": "Bloom, not C. polykrikoides-like"},
    {"code": 5, "key": "cp_like", "label": "C. polykrikoides-like bloom"}
  ],
  "regions": {
    "gulf":  {"label": "Arabian Gulf and Sea of Oman", "bbox": [47.5, 22.0, 60.0, 30.5]},
    "korea": {"label": "Korean south coast (test site)", "bbox": [125.5, 33.0, 130.5, 36.0]}
  },
  "scenes": [
    {
      "scene_id": "gulf_pace_20250308",
      "region": "gulf",
      "sensor": "pace",
      "date": "2025-03-08",
      "role": "probable_negative_test",
      "status": "real",
      "title": "Gulf of Oman swirls",
      "context": "NASA Earth Observatory: swirls likely include Noctiluca (not confirmed by sampling).",
      "source_url": "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/",
      "product": "PACE OCI L3M Rrs 4 km",
      "bands_used_nm": {"ratio_num": 667.5, "ratio_den": 442.5, "flh_peak": 677.5, "flh_base_low": 667.5, "flh_base_high": 717.5},
      "f0_source": "…",
      "files": {"grid": "scenes/gulf_pace_20250308/grid.json", "spectra": "scenes/gulf_pace_20250308/spectra.json"}
    }
  ]
}
```

- File paths in `files` are relative to `data/`. `spectra` may be `null`.
- Scenes are sorted by region, then date.

---

## 10. `sites.geojson` (owned by the interface)

This is a FeatureCollection of points, as `[lon, lat]` in WGS84. Each feature's properties:

| Property | Type | Allowed values |
|---|---|---|
| `site_id` | string | Unique, e.g. `gulf_desal_01` |
| `name` | string | Display name |
| `type` | string | `desalination`, `aquaculture`, `beach`, `port`, `other` |
| `region` | string | `gulf`, `korea` |

**Site status is computed in the browser** from `grid.json`, so the data team doesn't produce it:

| Status | When |
|---|---|
| Alert | A `cp_like` cell is within 25 km |
| Watch | A `cp_like` cell is within 75 km |
| Unknown | No usable water cell (codes 3–5) within 75 km |
| Clear | Otherwise |

The distances are interface settings. The mock sites are examples with made-up names; replace them with real locations before the demo.

---

## 11. Checks and changes

### Before every push

1. Run `python pipeline/validate_contract.py data`. It must end with **PASS**; read every WARN.
2. Look at your scene in the dashboard.
3. Commit only the paths you own (section 2).

### What the validator checks

**It fails the run when:**

- JSON is invalid or the versions don't match
- an ID doesn't match its folder, or the region, sensor or date doesn't match the ID
- an array's length isn't width × height, or a class code is outside 0–5
- a class code disagrees with the rule thresholds
- spectra lengths are inconsistent
- site properties are invalid

**It warns when:**

- more than 50% of water is classed as bloom (likely the 10× nflh unit mistake)
- the median water ratio is above 1.5 (likely 443 and 667 swapped)
- known land or sea test points have the wrong class (the grid is likely upside down)
- site coordinates look swapped
- a scene is still `mock`, or a reference is still a placeholder

### Changing this contract

- **Adding** a field or class is a minor bump (`1.0` → `1.1`). Old files keep working.
- **Renaming or removing** something is a major bump (`1.x` → `2.0`). The dashboard must refuse a manifest with a different major version and show a clear message.
- Whoever changes it updates this file, `export_contract.py` and `validate_contract.py` together, and posts the change in the team chat the same day.

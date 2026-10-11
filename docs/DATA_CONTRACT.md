# Data contract: Gulf Bloom Watch

**Contract version 1.0**

This is the single agreement between the data team (pipeline) and the interface (dashboard). If a file, field name, unit or code isn't written here, it doesn't exist yet. If anything here changes, bump `contract_version` and tell the whole team the same day (section 11).

Items marked **To confirm** are working values the data team still has to confirm.

---

## 1. Agree on these things first

- [ ] **Areas, scene list and IDs** (section 4)
- [ ] **Grid layout:** a regular lat/lon grid, with row 0 = north and column 0 = west (section 5)
- [ ] **Class codes 0–8**, their order and risk tiers (section 6)
- [ ] **Thresholds:** they live in `manifest.json`, written by the pipeline. The dashboard never hard-codes them (section 7)
- [ ] **Density gate:** chlorophyll **and** fluorescence (`nflh`), with the nflh threshold (sections 5 and 7)
- [ ] **Depth:** GEBCO depth on each area's grid, in `depth_<region>.json` (section 5); not assessed below 5 m, flagged from 5 m to under 15 m (section 7)
- [ ] **Clusters and references:** the cluster table, the six reference spectra, the two comparisons and the margin rule (sections 7 and 8)
- [ ] **Folder ownership,** and running the validator before every push (sections 2 and 11)

---

## 2. Who owns what

| Path | Owner | Written by |
|---|---|---|
| `data/manifest.json` | Data team | `update_manifest()` (never edit by hand) |
| `data/scenes/<scene_id>/grid.json` | Data team | `write_grid()` |
| `data/scenes/<scene_id>/spectra.json` | Data team | `write_spectra()` |
| `data/clusters.json` | Data team | `write_clusters()` |
| `data/depth_<region>.json` | Data team | `write_depth()` |
| `data/references.json` | Data team | `write_references()` |
| `data/sites.geojson` | Interface | By hand |
| `web/` (the dashboard) | Interface | |
| `pipeline/` | Data team | Helpers provided |

All the helper functions are in `pipeline/export_contract.py`. Use them rather than writing JSON by hand, so names, orientation and units can't drift.

---

## 3. Folder layout (data side)

```
data/
├── manifest.json            ← scenes + thresholds + classes + risk tiers + areas
├── clusters.json            ← the k-means cluster table (shared by all scenes)
├── references.json          ← the six reference spectra
├── depth_<region>.json      ← water depth of every cell, one file per area (optional)
├── sites.geojson            ← watched sites (interface-owned)
└── scenes/
    └── <scene_id>/
        ├── grid.json        ← class, chlorophyll, nflh and cluster for every pixel (required)
        └── spectra.json     ← sample pixel spectra for the chart (optional, recommended)
pipeline/
├── export_contract.py       ← writes every data file in this exact format
├── validate_contract.py     ← checks data/ against this contract (stdlib only)
├── import_map_export.py     ← turns the data team's map export (GeoTIFF grids + JSON) into these files
└── make_mock_data.py        ← mock data in mock-data/ (for the dashboard's checks), through export_contract.py
```

The web app reads `data/` over HTTP.

---

## 4. Areas, scenes and IDs

A **scene** is one date of PACE OCI data over the whole area, gridded from Level-2 to a regular lat/lon grid. Parts of the area without a usable pass that day (cloud, glint, outside the swath) are `no_data`.

**`scene_id` format:** `{region}_{sensor}_{YYYYMMDD}`, all lowercase, e.g. `gulf_pace_20260314`.

| Field | Allowed values |
|---|---|
| `region` | `gulf`, `oman` |
| `sensor` | `pace` |
| `role` | `analysis_bloom`, `analysis_calm`, `held_out_test` |
| `status` | `mock` (generated placeholder) or `real` (pipeline output) |

**The areas** (`[west, south, east, north]`, degrees). The analysis dates cover one box from 21.8°N to 27.03°N and 51.2°E to 60.79°E: the UAE's Arabian Gulf coast, the Strait of Hormuz, Musandam and the Oman coast of the Sea of Oman, from Qatar's east coast to past Ras al Hadd. The held-out test date has its own box, from 19°N to 26.5°N and 56°E to 63°E: the Gulf of Oman and Oman's Arabian Sea coast, following the test bloom's documented drift, so the result can be compared with NASA's images. Export each date over its area's whole box.

| Region | Label | Box | Dates |
|---|---|---|---|
| `gulf` | UAE and Oman coasts, Arabian Gulf to Sea of Oman | `[51.2, 21.8, 60.79, 27.03]` | The 11 analysis dates |
| `oman` | Sea of Oman and Oman's Arabian Sea coast | `[56.0, 19.0, 63.0, 26.5]` | The held-out test date |

**Roles**

| Role | Shown as | Meaning |
|---|---|---|
| `analysis_bloom` | Analysis date (bloom) | Pooled into the k-means fit. Water-type references are taken from these dates |
| `analysis_calm` | Analysis date (calm) | Pooled into the k-means fit so it learns normal water |
| `held_out_test` | Held-out test date | Not used in the fit. Pixels are assigned to the nearest existing cluster (`kmeans.predict`) and named by the same rules |

**Scenes**

| # | Date | Area | Why | Role |
|---|---|---|---|---|
| 1 | 30 Oct 2024 | Oman | Early season, first year | `analysis_bloom` |
| 2 | 3 Dec 2024 | Oman | Strong | `analysis_bloom` |
| 3 | 9 Dec 2024 | UAE | Moderate, UAE 2024–25 | `analysis_bloom` |
| 4 | 23 Jan 2025 | Oman | Mid-season | `analysis_bloom` |
| 5 | 6 Apr 2025 | Oman | Late season | `analysis_bloom` |
| 6 | 2 Oct 2025 | UAE | Early season, second year | `analysis_bloom` |
| 7 | 16 Nov 2025 | UAE | Mid-season | `analysis_bloom` |
| 8 | 14 Feb 2026 | UAE | Strong | `analysis_bloom` |
| 9 | 14 Mar 2026 | UAE | Late season | `analysis_bloom` |
| 10 | 11 Oct 2024 | Oman | Normal calm water | `analysis_calm` |
| 11 | 25 Oct 2025 | UAE | Normal calm water | `analysis_calm` |
| 12 | 24 Mar 2025 | Gulf of Oman and Oman's Arabian Sea coast (`oman`) | The bloom NASA documented | `held_out_test` |

Each date's grid covers its area's whole box, not just the coast it was chosen for.

The held-out date shows the Gulf of Oman bloom documented by NASA Earth Observatory and Copernicus, which PACE imaged on 8 and 24 March 2025. Both described it as likely green *Noctiluca*; the species was not confirmed by water sampling.

A real scene with the same ID overwrites the mock one.

---

## 5. `grid.json`, the main file (one per scene)

### Grid layout

- The grid is a **regular latitude/longitude grid** (EPSG:4326) with constant spacing: **0.01°** (about 1.1 km, roughly PACE's pixel size). The `gulf` area is 959 × 523 = 501,557 cells and the `oman` area 700 × 750 = 525,000, about 9 MB per scene (about 0.8 MB compressed when served).
- PACE Level-2 swaths are resampled onto it by nearest neighbour (about 2 km search radius) after the quality flags are applied. Rrs, chlor_a, nflh and bbp go onto the same grid, so a cell is the same spot of sea on every date.
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
  "scene_id": "gulf_pace_20260314",
  "bbox": [51.2, 21.8, 60.79, 27.03],
  "res_deg": [0.01, 0.01],
  "width": 959,
  "height": 523,
  "class_code": [0, 1, 3, 3, 4, 7, 6],
  "chlor_a":    [null, null, 0.62, 3.1, 7.45, 18.2, 24.9],
  "nflh":       [null, null, 0.0262, 0.0511, 0.1834, 0.4401, 0.5973],
  "cluster_id": [null, null, 0, 4, 21, 13, 9]
}
```

### Fields

| Field | Type | Required | Units | Decimals | Notes |
|---|---|---|---|---|---|
| `contract_version` | string | yes | | | `"1.0"` |
| `scene_id` | string | yes | | | Must match the folder name |
| `bbox` | 4 numbers | yes | degrees | | Outer edges: the scene's area box (section 4) |
| `res_deg` | 2 numbers | yes | degrees | | `[res_lon, res_lat]` |
| `width`, `height` | integers | yes | | | Columns, rows |
| `class_code` | int array | yes | | | Codes 0–8 (section 6). Never null |
| `chlor_a` | float array | yes | mg m⁻³ | 2 | Chlorophyll-a from `PACE_OCI_L2_BGC` |
| `nflh` | float array | yes | W m⁻² µm⁻¹ sr⁻¹ (`rule.nflh_units`) | 4 | Normalized fluorescence line height from `PACE_OCI_L2_AOP`: the faint red glow of living algae near 678 nm. `null` where missing; a missing value counts as not raised |
| `cluster_id` | int array | yes | | | The pixel's k-means cluster (section 7). `null` for codes 0–2 |

For codes 3–8, `chlor_a` and `cluster_id` must not be null.

**Size limits:** `width × height ≤ 600,000` and file ≤ 15 MB. The `gulf` area at 0.01° is 959 × 523 = 501,557 cells; the `oman` area is 700 × 750 = 525,000.

### `depth_<region>.json` (one file per area, optional)

The water depth of every cell of an area, so the dashboard can show it for a clicked pixel and flag shallow water where the seabed may show (section 7). `write_depth()` writes it once per area, from GEBCO bathymetry resampled to the same 0.01° cells as that area's scenes. Without it the dashboard can't show either, so write it.

```json
{
  "contract_version": "1.0",
  "bbox": [51.2, 21.8, 60.79, 27.03],
  "res_deg": [0.01, 0.01],
  "width": 959,
  "height": 523,
  "units": "m",
  "source": "GEBCO, resampled to the 0.01° grid",
  "depth_m": [null, null, 7, 12, 48, 61, 2210]
}
```

- Same `bbox`, `res_deg`, `width`, `height` and row order as the area's scenes' `grid.json`.
- `depth_m`: metres below sea level, **positive**, whole metres; `null` on land. It may also be `null` in water shallower than `shallow_max_m` when the source leaves it out (those cells are code 1 anyway). GEBCO gives elevation (negative at sea): store `-elevation`.
- Make the shallow mask with `shallow_mask(depth)` and the flagged zone with `shallow_flag(depth)`. Both compare the same rounded depth, so code 1, the flag and this file always agree.
- The manifest's `regions.<region>.depth_file` names it; `write_manifest()` fills that in when the file exists.

---

## 6. Class codes (fixed)

Each pixel goes through these checks top to bottom, and **the first one that applies wins**. Shallow water comes before the quality flags: a cloudy cell under `shallow_max_m` deep is shallow, not no data. A pixel is **dense** when `chlor_a ≥ chl_dense_min` **and** `nflh ≥ nflh_dense_min` (a missing nflh is not raised). A species is named only when the cluster's two comparisons, shape and pigment features (section 7), pick the same reference.

| Code | Key | Label | When | Risk tier |
|---|---|---|---|---|
| 0 | `land` | Land | Land mask | `not_assessed` |
| 1 | `shallow` | Shallow water, not assessed | Shallower than `shallow_max_m`, whatever the quality flags say | `not_assessed` |
| 2 | `no_data` | No data | Cloud, glint or failed quality flags, or chlorophyll / cluster missing | `not_assessed` |
| 3 | `clear` | Non-bloom water | `chlor_a < chl_weak_min`, **or** not dense and the cluster's best match is a water reference | `none` |
| 4 | `weak_unclassified` | Weak bloom, unclassified | Not dense: chlorophyll below `chl_dense_min`, or nflh not raised | `monitor` |
| 5 | `dense_unclassified` | Dense bloom, unclassified | The cluster's best match is a water reference, its margin is `< margin_min`, **or** the two comparisons pick different references | `watch` |
| 6 | `cp_like` | *C. polykrikoides*-like bloom | Best match is `cp`, by both comparisons | `high` |
| 7 | `noctiluca_like` | Green *Noctiluca*-like bloom | Best match is `noctiluca_green`, by both comparisons | `monitor` |
| 8 | `diatom_like` | Diatom-like bloom | Best match is `diatom`, by both comparisons | `low` |

**Flags on top of the class.** The dashboard works these out from the files; they are not stored, and they never change the class.

| Flag | When | Note in the pixel details |
|---|---|---|
| shallow_zone | Codes 3–8, at least `shallow_max_m` and under `shallow_flag_max_m` deep (from the area's depth file) | "Shallow water (5–15 m): the seabed may affect this result" |
| turbid | Code 3, the cluster's best match is `water_turbid`, and `chlor_a` ≥ `chl_dense_min` | "Turbid water: the chlorophyll reading is likely inflated by sediment" |

Use `classify()` so the order is always the same. It compares values **rounded to the stored decimals**, so the shown numbers and the class always agree.

**Shallow means not assessed, not "no bloom".** In water this shallow, light reflected by the seabed and stirred-up sediment raise the chlorophyll reading (and seabed vegetation can raise the red signal too), so no species is named there. Leave these cells out of the clustering, but still store their `chlor_a` and `nflh`: the dashboard shows them.

Water from `shallow_max_m` to `shallow_flag_max_m` deep is classified as usual, codes 3–8, but flagged: the seabed may still show (section 7).

**Risk tiers** (in `manifest.risk_tiers`, lowest first): `not_assessed` (Not assessed: land, shallow water and no data, never tested), `none` (No flag), `low` (Low), `monitor` (Monitor), `watch` (Watch), `high` (High). A diatom-like bloom is Low; a weak bloom and a *Noctiluca*-like bloom are Monitor; a dense bloom that can't be named is Watch, since it could still be *C. polykrikoides*. A tier is a level of concern for operators, not a toxicity claim.

---

## 7. Thresholds, clusters and confidence

### Thresholds

The `rule` block in `manifest.json` is written by the pipeline from `RULE` in `export_contract.py`. The dashboard reads every threshold from there.

```json
"rule": {
  "name": "Chlorophyll and fluorescence density gate, then k-means clusters named by two spectral-angle (SAM) comparisons and the SAM margin",
  "chl_product": "PACE_OCI_L2_BGC chlor_a",
  "chl_units": "mg m^-3",
  "chl_weak_min": 5.0,
  "chl_dense_min": 10.0,
  "nflh_product": "PACE_OCI_L2_AOP nflh",
  "nflh_units": "W m^-2 um^-1 sr^-1",
  "nflh_dense_min": 0.2479,
  "margin_min": 0.25,
  "margin_formula": "(angle to second-best reference - angle to best reference) / angle between those two references, clipped to 0-1",
  "confidence_bands": [
    {"key": "low", "label": "Low", "min": 0.25},
    {"key": "medium", "label": "Medium", "min": 0.5},
    {"key": "high", "label": "High", "min": 0.75}
  ],
  "sam_range_nm": [500.0, 700.0],
  "deriv_filter": "Savitzky-Golay",
  "deriv_range_nm": [430.0, 700.0],
  "deriv_window": 11,
  "deriv_polyorder": 2,
  "shallow_max_m": 5.0,
  "shallow_flag_max_m": 15.0
}
```

- **Density gate, two signals:** below 5 mg m⁻³ of chlorophyll is no bloom. A pixel is dense enough to name a species only with chlorophyll 10 or more **and** nflh at least `nflh_dense_min`. Living algae fluoresce; mud and seabed raise the chlorophyll estimate but don't, so the second signal filters out many muddy-water false alarms. Anything in between is a weak bloom.
- **nflh units:** PACE's own unit, W m⁻² µm⁻¹ sr⁻¹ (check the file's `units` attribute). 1 mW cm⁻² µm⁻¹ sr⁻¹ = 10 W m⁻² µm⁻¹ sr⁻¹.
- **Shallow water:** water shallower than 5 m (`shallow_max_m`) is not assessed. From 5 m to under 15 m deep (`shallow_flag_max_m`), it is assessed but flagged: sand or seagrass on the bottom can still show through, so the dashboard warns "Shallow water: the seabed may affect this result" in the pixel details and in a site's note. The flag comes from the area's depth file, so it is the same on every date and needs no field in `grid.json`; in the pipeline, `shallow_flag(depth)` gives it. It never changes the class.
- **nflh threshold:** `nflh_dense_min` is 0.2479 W m⁻² µm⁻¹ sr⁻¹: the 95th percentile of nflh over normal-water pixels (chlorophyll under 1) on the calm dates, so a pixel above it glows more than nearly all normal water.
- **Shape comparison** (`sam_range_nm`): only 500–700 nm. Below about 490 nm the atmospheric correction over-corrects dense blooms, often to below zero (in 94–100% of the dense pixels on the bloom dates), so the blue bands would mislead the match.
- **Pigment-feature comparison** (`deriv_*`): on the curves' own PACE bands over `deriv_range_nm`, each band gets the second derivative of a degree-`deriv_polyorder` curve fitted by least squares through `deriv_window` neighbouring bands (a Savitzky–Golay filter, counted by band, not resampled). Bands whose window runs past either end are left out. A reference is resampled onto the cluster's bands first.

### Clusters

k-means (two levels: coarse, then fine inside each coarse group) is fitted once on the PCA-compressed spectra (430–700 nm) of the pooled analysis dates. The held-out dates reuse the same clusters. So the cluster table is shared by every scene and lives in `data/clusters.json`.

For each cluster, the pipeline compares its **mean spectrum** with each of the six references (section 8) twice, by spectral angle (SAM, degrees; smaller = more similar):

1. **Shape** (`sam_deg`): SAM on the reflectance curves themselves, over `sam_range_nm`. SAM ignores overall brightness, so this compares shape only. The margin, and so the confidence, come from these angles.
2. **Pigment features** (`sam_deriv_deg`): SAM on the smoothed second derivative of the same curves (`spectral_angle_deriv_deg()`). The second derivative measures how sharply a curve bends at each wavelength: broad, smooth backgrounds such as a sediment slope or a constant offset barely bend and almost vanish, while the narrow dips and bumps that pigments make stand out. Smoothing first matters, because a plain second derivative is mostly noise.

```
margin = (θ_second − θ_best) / θ_gap        clipped to 0–1, from the unrounded shape angles
θ_gap  = the shape angle between the best and second-best references themselves
```

The margin says how clearly the best reference beat the runner-up, measured against how different those two references are from each other: a small lead between two references that look alike counts for more than the same lead between two that look nothing alike. It is taken over all six references.

- **Naming:** if the shape's best match is a water reference, the cluster is `water`. If the margin is below `margin_min`, **or** the pigment features' best match (`best_ref_deriv`) differs from the shape's (`best_ref`), it's `unclassified`. Otherwise it's named after the best-matching bloom reference.

**Confidence = the margin,** on a 0–1 scale, per cluster. It's shown for classes 6–8 only:

| Margin | Meaning |
|---|---|
| below 0.25 | Too close to call: the cluster stays unclassified |
| 0.25 to below 0.5 | Low confidence |
| 0.5 to below 0.75 | Medium |
| 0.75 and above | High |

The margin is a **relative separation score, not a probability.** 0.8 means "clearly closer to this reference than to the next one", not "80% chance". There's no confirmed data to calibrate it into a probability.

### `data/clusters.json`

```json
{
  "contract_version": "1.0",
  "units": "sr^-1",
  "units": "normalized",
  "fit": {"dates": ["2024-10-11", "2024-10-30"], "k_coarse": 6, "k_fine": 30, "pca_components": 5, "notes": "…"},
  "wavelengths_nm": [430.0, 432.5, 435.0],
  "clusters": [
    {"cluster_id": 20, "parent_id": null, "n_pixels": 9313, "mean_rrs": [0.0389, 0.0412, 0.0436],
     "sam_deg": {"cp": 20.15, "noctiluca_green": 12.37, "diatom": 27.4, "water_clear": 28.82, "water_turbid": 18.21, "seabed": 17.74},
     "best_ref": "noctiluca_green", "second_ref": "seabed", "ref_gap_deg": 15.6, "margin": 0.34,
     "sam_deriv_deg": {"cp": 32.93, "noctiluca_green": 25.12, "diatom": 50.57, "water_clear": 56.45, "water_turbid": 27.89, "seabed": 28.4},
     "best_ref_deriv": "noctiluca_green", "label_key": "noctiluca_like"}
  ]
}
```

| Field | Notes |
|---|---|
| `units` (top level) | Of `mean_rrs`: `sr^-1`, or `normalized` for curves scaled to unit length (SAM compares shape only, so either works) |
| `cluster_id` | Unique integer; what `grid.json` points to |
| `parent_id` | The coarse group it came from, or `null` when not known |
| `n_pixels` | Pixels in this cluster over the fitted dates |
| `mean_rrs` | Mean curve (5 decimals, in `units`), same length as `wavelengths_nm` |
| `sam_deg` | Shape: the angle to every reference, 2 decimals |
| `best_ref`, `second_ref` | The two smallest shape angles |
| `ref_gap_deg` | The shape angle between `best_ref` and `second_ref` themselves, 2 decimals |
| `margin` | 2 decimals, from the unrounded angles |
| `sam_deriv_deg` | Pigment features: the angle between second derivatives to every reference, 2 decimals, 0–180 |
| `best_ref_deriv` | The smallest pigment-feature angle |
| `label_key` | `cp_like`, `noctiluca_like`, `diatom_like`, `water` or `unclassified` |

`cluster_record()` computes `best_ref`, `second_ref`, `ref_gap_deg`, `margin`, `best_ref_deriv` and `label_key` from the two sets of angles and `reference_gaps()`; `write_clusters()` writes the file.

---

## 8. Spectra: `references.json` and `spectra.json`

### `data/references.json`

Exactly six references. The `group` decides whether a best match names a bloom or means "not a bloom".

| `ref_id` | Group | What | Source (to confirm: full citations) |
|---|---|---|---|
| `cp` | bloom | *C. polykrikoides* | Kim, Yoo & Son (2016), Korean field measurements, digitized |
| `noctiluca_green` | bloom | Green *Noctiluca* | Dwivedi et al. (2015), Northern Arabian Sea, digitized |
| `diatom` | bloom | Diatom bloom | Dwivedi et al. (2015), Northern Arabian Sea, digitized |
| `water_clear` | water | Clear offshore water | Pixels from our own analysis dates: offshore, chlorophyll under 0.3, deeper than 50 m |
| `water_turbid` | water | Turbid coastal water | Pixels from our own analysis dates: the top 5% of particle backscatter (bbp, `PACE_OCI_L2_IOP`), at least 15 m deep, not dense |
| `seabed` | water | Shallow seabed | Pixels 5–15 m deep (`shallow_flag(depth)`) from our own analysis dates: the brightest 10% at 555 nm, chlorophyll under 5 |

```json
{
  "contract_version": "1.0",
  "references": [
    {"ref_id": "cp", "group": "bloom", "label": "C. polykrikoides (Korean field measurement)",
     "source": "Full citation", "source_url": "https://...",
     "units": "normalized", "wavelengths_nm": [430, 432.5], "rrs": [0.0269, 0.0281],
     "notes": "Bloom density, date, how it was measured"}
  ]
}
```

References keep their own wavelengths and `units` (`sr^-1`, or `normalized` for curves scaled to unit length). Resampling to PACE bands for SAM happens in the pipeline (`spectral_angle_deg()` does it).

### `data/scenes/<scene_id>/spectra.json` (optional)

Sample pixel spectra for the chart.

```json
{
  "contract_version": "1.0",
  "scene_id": "gulf_pace_20250324",
  "units": "sr^-1",
  "wavelengths_nm": [400.0, 405.0, 410.0],
  "probes": [
    {"probe_id": "p01", "lon": 58.71, "lat": 24.33, "class_code": 7, "rrs": [0.0021, 0.0023, 0.0024]}
  ],
  "class_means": {"3": [0.0071, 0.0069, 0.0066], "7": [0.0016, 0.0016, 0.0017]}
}
```

- `wavelengths_nm` is strictly ascending. Leave out bands you don't have (PACE files leave out about 590–610 nm); don't fill them with zeros.
- Each `rrs` array and each `class_means` array has the same length as `wavelengths_nm`. `null` is allowed inside them.
- **Probes** are 10–50 pixels: the strongest named blooms plus some of each other water class. `pick_probes()` does this.
- `class_means` keys are class codes as strings ("3"–"8").
- Keep the file ≤ 1 MB.

---

## 9. `manifest.json`

The manifest is generated by `update_manifest()`. This is the full shape:

```json
{
  "contract_version": "1.0",
  "generated_utc": "2026-10-09T12:00:00Z",
  "rule": {"...": "section 7"},
  "risk_tiers": [
    {"key": "not_assessed", "label": "Not assessed", "rank": 0},
    {"key": "none", "label": "No flag", "rank": 1},
    {"key": "low", "label": "Low", "rank": 2},
    {"key": "monitor", "label": "Monitor", "rank": 3},
    {"key": "watch", "label": "Watch", "rank": 4},
    {"key": "high", "label": "High", "rank": 5}
  ],
  "classes": [
    {"code": 0, "key": "land", "label": "Land", "risk_tier": "not_assessed"},
    {"code": 1, "key": "shallow", "label": "Shallow water, not assessed", "risk_tier": "not_assessed"},
    {"code": 2, "key": "no_data", "label": "No data", "risk_tier": "not_assessed"},
    {"code": 3, "key": "clear", "label": "Non-bloom water", "risk_tier": "none"},
    {"code": 4, "key": "weak_unclassified", "label": "Weak bloom, unclassified", "risk_tier": "monitor"},
    {"code": 5, "key": "dense_unclassified", "label": "Dense bloom, unclassified", "risk_tier": "watch"},
    {"code": 6, "key": "cp_like", "label": "C. polykrikoides-like bloom", "risk_tier": "high"},
    {"code": 7, "key": "noctiluca_like", "label": "Green Noctiluca-like bloom", "risk_tier": "monitor"},
    {"code": 8, "key": "diatom_like", "label": "Diatom-like bloom", "risk_tier": "low"}
  ],
  "regions": {
    "gulf": {"label": "UAE and Oman coasts, Arabian Gulf to Sea of Oman", "bbox": [51.2, 21.8, 60.79, 27.03], "depth_file": "depth_gulf.json"},
    "oman": {"label": "Sea of Oman and Oman's Arabian Sea coast", "bbox": [56.0, 19.0, 63.0, 26.5], "depth_file": "depth_oman.json"}
  },
  "scenes": [
    {
      "scene_id": "oman_pace_20250324",
      "region": "oman",
      "sensor": "pace",
      "date": "2025-03-24",
      "role": "held_out_test",
      "status": "real",
      "title": "Held-out test, 24 Mar 2025",
      "context": "Bloom documented by NASA Earth Observatory and Copernicus as likely green Noctiluca; species not confirmed by water sampling. …",
      "source_url": "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086",
      "products": ["PACE_OCI_L2_AOP", "PACE_OCI_L2_BGC", "PACE_OCI_L2_IOP"],
      "links": [
        {"label": "NASA Earth Observatory", "url": "https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086"},
        {"label": "Copernicus", "url": "https://eu-space.europa.eu/components/earth-observation-copernicus/image-of-day/algal-bloom-gulf-oman"}
      ],
      "files": {"grid": "scenes/oman_pace_20250324/grid.json", "spectra": null}
    }
  ]
}
```

- File paths in `files` are relative to `data/`. `spectra` may be `null`.
- `clusters.json` and `references.json` are always at those fixed paths.
- `regions` lists the areas the scenes use. Each area's `depth_file` is `"depth_<region>.json"` when that file exists, otherwise `null`.
- `links` (optional, may be empty): more sources for the scene, each `{label, url}`; the dashboard shows them with `source_url`.
- Scenes are sorted by region, then date.

---

## 10. `sites.geojson` (owned by the interface)

This is a FeatureCollection of points, as `[lon, lat]` in WGS84. Each feature's properties:

| Property | Type | Allowed values |
|---|---|---|
| `site_id` | string | Unique, e.g. `gulf_desal_01` |
| `name` | string | Display name |
| `type` | string | `desalination`, `aquaculture`, `beach`, `port`, `other` |
| `region` | string | `gulf` |
| `source` | string, optional | Where the location comes from, e.g. `OpenStreetMap` |
| `source_url` | string, optional | A link to that source |
| `approximate` | boolean, optional | `true` when the exact spot isn't published and the point is an estimate |

**Site status is computed in the browser** from the `grid.json` of the date that covers the site, so the data team doesn't produce it. A site keeps `region: "gulf"` even when the held-out test date's area covers it:

| Status | When |
|---|---|
| Alert | A `cp_like` cell is within 25 km by sea |
| Nearby | A `cp_like` cell is within 75 km by sea |
| Unknown | No usable water cell (codes 3–8) within 75 km by sea, or none of the date's grids reaches the site |
| Clear | Otherwise |

Distances are **by sea**: the shortest way through the water (any code but land), around land, so a bloom on the far side of a peninsula such as Musandam doesn't count as near. In open water this is the straight-line distance.

The distances are interface settings. The sites are real: seawater desalination plants, fish farms (sea cages and seawater hatcheries or ponds) and public beaches on the UAE and Oman coasts. Confirm the ones marked `approximate` before the demo.

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
- a grid's or depth file's box isn't its area's box
- an array's length isn't width × height, or a class code is outside 0–8
- a pixel's class doesn't follow from its chlorophyll, its nflh, its cluster and the thresholds
- a cluster's best/second reference, reference gap, margin, pigment-feature best match or label doesn't match its angles and the references
- references, spectra or site properties are invalid

**It warns when:**

- over half of the water is at or above the dense-bloom gate (chlorophyll in the wrong units?)
- nflh values look like the wrong unit
- an area has no depth file, it holds negative depths (GEBCO elevation?), shallow cells (code 1) disagree with it, or water cells have no depth
- known land or sea test points have the wrong class (the grid is likely upside down)
- site coordinates look swapped
- a scene or the depth is still `mock`, a reference is still a placeholder, or a site is still an example or has an approximate location

### Changing this contract

- **Adding** a field or class is a minor bump (`1.0` → `1.1`). Old files keep working.
- **Renaming or removing** something is a major bump (`1.x` → `2.0`). The dashboard must refuse a manifest with a different major version and show a clear message.
- Whoever changes it updates this file, `export_contract.py` and `validate_contract.py` together, and posts the change in the team chat the same day.

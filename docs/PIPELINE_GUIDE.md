# Pipeline guide (data team)

The pipeline's goal is to produce real data files that pass `python pipeline/validate_contract.py data`. The exact format is in `DATA_CONTRACT.md`; this guide covers how to get there with the helpers in `pipeline/export_contract.py`.

## From the map export

The data team's notebook writes a map export: one `<timestamp>_grid.tif` per date (8 float32 bands: label, chlor_a, density_class, cluster, shallow_flag, depth, confidence, nflh; NaN where empty) and the shared `scenes.json`, `legend.json`, `cluster_spectra.json`, `references.json` and `summary.json`. Turn it into the contract files with:

```bash
python pipeline/import_map_export.py <export folder>
python pipeline/validate_contract.py data
```

The import keeps every class the export gives, and stops if anything disagrees with it:

- it maps the export's label codes (−1 land, 0 no data, 1 very shallow, 2–7 the water classes) to the contract's 0–8
- it recomputes every cluster's angles to the six references (shape and pigment features), the reference gap, the margin and the label with the helpers below, and checks them against `cluster_spectra.json`
- it reclassifies every pixel with `classify()` from the stored values and checks the result against the export's label
- it writes each area's depth file from the depth band (null on land and under 5 m, where the export leaves it out)
- a value within one display step of a threshold (chlorophyll 4.997 for a pixel the pipeline put below 5) is stored on the side the pipeline decided (4.99), so the shown number and the class agree; the class never changes, and the script prints how many values it adjusted

The thresholds in `summary.json` must equal `RULE`; the import checks that too. The PNG and GeoJSON files in the export are previews; the dashboard doesn't need them. The import removes mock scenes from `data/`; the mock data for the dashboard's checks lives in `mock-data/` (`python pipeline/make_mock_data.py`).

## Steps (writing the contract files directly)

1. **Get the data.** A free NASA Earthdata login and the `earthaccess` Python library make searching and downloading easy. For each date, download the PACE OCI Level-2 `AOP` (Rrs and nflh), `BGC` (chlor_a) and `IOP` (bbp) granules over the area. Full PACE files are large: find the part of each swath that overlaps the box and read only that. bbp picks the turbid-water reference pixels.
2. **Grid.** Apply the quality flags on the swath first: keep a pixel only when none of the excluded flags are set and its visible spectrum (400–700 nm) has no missing values; the rest become empty. Then resample each swath onto its area's regular 0.01° lat/lon grid by nearest neighbour, e.g. pyresample's `resample_nearest` with a search radius of about 2 km. The analysis dates use the `gulf` box (21.8–27.03°N, 51.2–60.79°E: 959 × 523 cells); the held-out test date uses the `oman` box (19–26.5°N, 56–63°E: 700 × 750 cells). Put Rrs, chlor_a, nflh and bbp on the same grid, so a cell is the same spot of sea on every date. Export every date over its whole box; parts without a usable pass become no data. Keep Rrs as (lat, lon, band) in sr⁻¹, chlor_a as (lat, lon) in mg m⁻³ and nflh as (lat, lon) in `RULE["nflh_units"]`.
3. **Depth, once per area.** Resample GEBCO bathymetry to the same 0.01° cells, as positive metres below sea level (`-elevation`, NaN on land), and write it once for each area:
   ```python
   bbox, res, (depth,) = orient_grid(lat, lon, depth)
   write_depth(DATA_DIR, "gulf", bbox, res, depth, source="GEBCO 2024, resampled to the 0.01 deg grid")
   ```
4. **Masks** (2-D booleans, same shape):
   - `land`: from the product's land flag, or a land mask.
   - `no_data`: clouds, glint and failed quality flags, plus fill values.
   - `shallow = shallow_mask(depth)`: shallower than `RULE["shallow_max_m"]` (5 m). It comes before the quality flags: a cloudy cell this shallow is still shallow (code 1), not no data. Leave these cells out of the PCA and k-means; keep their chlor_a and nflh in the grid if you have them. It compares the rounded depth, so the classes always agree with the depth file.
   - Water from 5 m to under 15 m deep (`shallow_flag(depth)`, up to `RULE["shallow_flag_max_m"]`) stays in and is classified as usual. The dashboard flags it from the depth file, so there's nothing extra to write.
5. **Sanity-check** raw spectra at a few surviving pixels before building anything on top.
6. **PCA and k-means** on the pooled analysis dates (both bloom and calm), over 430–700 nm. Two levels: coarse groups, then finer clusters inside each. Aim for tens of clusters, not thousands. 3×3 neighbourhood features can add spatial context. Assign the held-out test date with `kmeans.predict`. Keep a `cluster_id` per pixel (NaN where masked).
7. **Name the clusters, once for the whole fit.** Two comparisons per cluster: the shape (SAM on the curves over `RULE["sam_range_nm"]`, 500–700 nm, as the blue bands are over-corrected in dense blooms) and the pigment features (SAM on their smoothed second derivatives, which flatten broad backgrounds and keep narrow pigment dips and bumps):
   ```python
   gaps = reference_gaps({ref_id: (ref_wavelengths, ref_rrs) for ref_id in REFERENCES})
   angles = {ref_id: spectral_angle_deg(mean_rrs, ref_rrs, wavelengths, ref_wavelengths) for ref_id in REFERENCES}
   deriv = {ref_id: spectral_angle_deriv_deg(mean_rrs, ref_rrs, wavelengths, ref_wavelengths) for ref_id in REFERENCES}
   rec = cluster_record(cluster_id, mean_rrs, angles, n_pixels, parent_id, sam_deriv_deg=deriv, ref_gaps=gaps)
   ```
   `spectral_angle_deriv_deg()` resamples the reference onto the cluster's own bands and applies a Savitzky–Golay second derivative on those bands over `RULE["deriv_range_nm"]` (`deriv_window` bands, degree `deriv_polyorder`; numpy only), leaving out the edges. `reference_gaps()` is the shape angle between every two references. `cluster_record()` picks the best and second-best shape references, computes the margin, (θ₂ − θ₁) / the gap between those two references, clipped to 0–1, then the best pigment-feature reference and the label: a species only when both comparisons pick it and the margin passes. Then:
   ```python
   write_references(DATA_DIR, references)        # the six reference spectra, with full sources
   write_clusters(DATA_DIR, wavelengths, clusters, {"dates": [...], "k_coarse": ..., "k_fine": ..., "pca_components": ...})
   ```
   Curves scaled to unit length are fine: pass `units="normalized"` to `write_clusters()` and set `"units": "normalized"` on each reference.
8. **Per scene, classify and export:**
   ```python
   code = classify(chlor_a, cluster_id, clusters, land, no_data, shallow, nflh=nflh)
   bbox, res, (code, chlor_a, nflh, cluster_id, rrs) = orient_grid(lat, lon, code, chlor_a, nflh, cluster_id, rrs)
   write_grid(DATA_DIR, scene_id, bbox, res, code, chlor_a, cluster_id, clusters, nflh=nflh)
   probes, means = pick_probes(bbox, res, code, chlor_a, rrs)
   write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)
   update_manifest(DATA_DIR, {"scene_id": scene_id, "role": "...", "status": "real", "title": "...",
                              "context": "...", "source_url": "...", "links": [{"label": "...", "url": "..."}],
                              "products": ["PACE_OCI_L2_AOP", "PACE_OCI_L2_BGC", "PACE_OCI_L2_IOP"]})
   ```
   `classify()` applies the two-signal density gate: dense means `chlor_a ≥ chl_dense_min` and `nflh ≥ nflh_dense_min`. `RULE["nflh_dense_min"]` is 0.2479 W m⁻² µm⁻¹ sr⁻¹, the data team's threshold. The scene's `scene_id` starts with its area (`gulf_…` or `oman_…`), and `write_grid()` checks the grid is that area's box. `export_scene_example()` at the bottom of `export_contract.py` is a fill-in-the-blanks version.
9. **Write the contract files.** The dashboard reads only `grid.json` per date, `clusters.json`, `references.json`, each area's `depth_<region>.json` and, optionally, `spectra.json`, all written by the helpers above. A GeoJSON per cluster, a PNG or a CSV can be useful extras for the pitch, but the dashboard doesn't read them.
10. **Validate:** run `python pipeline/validate_contract.py data`. Fix every FAIL and read every WARN.

## Reference spectra

- **Bloom references:** *C. polykrikoides* from the Korean field study (Kim, Yoo & Son 2016), green *Noctiluca* and diatom from the Northern Arabian Sea study (Dwivedi et al. 2015). If a spectrum is only in a figure, digitize it carefully and note the bloom density and date. Put the full citation in `source`.
- **Water references:** mean spectra taken from our own analysis dates: clear offshore pixels (chlorophyll under 0.3, deeper than 50 m), turbid pixels (the top 5% of bbp, at least 15 m deep, not dense), and shallow-seabed pixels 5–15 m deep (`shallow_flag(depth)`; the brightest 10% at 555 nm, chlorophyll under 5). Say which dates and areas in `source`.
- **Green, not red, *Noctiluca*.** The Arabian Sea form is green (it carries a green symbiont); the red form found elsewhere is optically different.

## Traps we already know about

| Trap | What happens | Fix |
|---|---|---|
| Latitude south → north | The map is upside down | `orient_grid()`; the validator warns about it |
| Level-2 swath data | Not a regular grid | Resample to the regular 0.01° grid before `orient_grid()` |
| chlor_a in log10 | Negative values, nothing passes the gate | Store mg m⁻³; the validator fails negative values |
| nflh in the wrong unit | The fluorescence gate passes everything or nothing | Keep `RULE["nflh_units"]` (W m⁻² µm⁻¹ sr⁻¹); 1 mW cm⁻² µm⁻¹ sr⁻¹ = 10 W m⁻² µm⁻¹ sr⁻¹. The validator warns about values above 5 |
| GEBCO gives elevation | Depths are negative, nothing is shallow | Store `-elevation`; `write_depth()` refuses mostly negative depths |
| PACE drops about 590–610 nm | A gap in the spectra | Leave those bands out of `wavelengths_nm`; SAM uses shared bands only |
| Blue bands in dense blooms | Over-corrected, often below zero | The shape comparison uses `RULE["sam_range_nm"]` (500–700 nm) only |
| Turbid water or shallow seabed | Looks like a bloom | Quality flags, the shallow mask and flag, the fluorescence check and the water references in the naming |
| Your own depth cutoff | 5 m cells land on the wrong side; the validator warns that classes and the depth file disagree | Use `shallow_mask()` and `shallow_flag()`; don't compare depths yourself |
| Values right at a threshold | Class and shown value disagree | `classify()` compares rounded values; don't classify another way |
| A grid over the wrong box | The dashboard can't place it, the depth doesn't match | Export each date over its area's box (`REGIONS`); `write_grid()` and the validator check it |

## What to tell the interface after each export

- The `scene_id` and whether it replaced a mock scene
- The validator result, including warnings
- Anything unusual: a large cloud gap, a low-confidence date, or a change to the references or the cluster fit

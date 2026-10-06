# Pipeline guide (data team)

The pipeline's goal is to produce real data files that pass `python pipeline/validate_contract.py data`. The exact format is in `DATA_CONTRACT.md`; this guide covers how to get there.

## Steps for one real scene

1. **Pick the scene.** Choose a clear-sky date for each planned scene (contract section 4):
   - **Korea:** check the PACE true-color images around the August 2026 NIFS alert dates. August is often cloudy, so look for gaps in the clouds over the South Sea coast.
   - **Gulf of Oman:** 8 March 2025 (NASA also used PACE data from 24 March 2025).
   - **2008:** MODIS-Aqua, October–December 2008 (the documented bloom).
2. **Get the data.** You need a free NASA Earthdata login, and the `earthaccess` Python library makes searching and downloading easy.
   - **PACE OCI:** the Level-3 mapped Rrs product (4 km, daily) is the simplest, since it's already a regular grid. Level-2 AOP gives finer coastal detail but has to be gridded first.
   - **MODIS-Aqua (2008):** Rrs from NASA's Ocean Biology DAAC.
3. **Compute the rule inputs** with `compute_rule_inputs(rrs, wavelengths, f0, flh_base_high_nm=…)` from `pipeline/export_contract.py`:
   - `rrs` is shaped (lat, lon, band), in sr⁻¹.
   - `f0` is solar irradiance in **mW cm⁻² µm⁻¹** for the same bands. Take it from the file's metadata if present, or else from a standard solar spectrum (e.g. Thuillier 2003) at the band centers. Write the source into `f0_source`.
   - `flh_base_high_nm` is `748` for MODIS and about `717` for PACE, because standard PACE Rrs stops at about 719 nm.
4. **Build the masks** (2-D booleans, same shape):
   - `land`: from the product's land flag, or a land mask.
   - `no_data`: clouds, dust and failed quality flags (Level-2 flags), plus fill values.
   - `shallow`: depth less than `RULE["shallow_max_m"]`, from bathymetry such as GEBCO.
5. **Classify:** `code = classify(ratio, nflh, land, no_data, shallow)`.
6. **Orient:** `bbox, res, (code, ratio, nflh, sam, rrs) = orient_grid(lat, lon, code, ratio, nflh, sam, rrs)`. It flips south → north latitude for you.
7. **Optional spectral angle (PACE only).**
   - Resample the reference spectrum to the scene bands over a shared range (e.g. 400–700 nm, skipping missing bands).
   - Then compute `sam_deg = degrees(arccos(dot(a, b) / (|a| · |b|)))` per pixel.
   - Set it to NaN where `code < 3`.
8. **Export:**
   ```python
   write_grid(DATA_DIR, scene_id, bbox, res, code, ratio, nflh, sam_deg=sam)
   probes, means = pick_probes(bbox, res, code, ratio, rrs)
   write_spectra(DATA_DIR, scene_id, wavelengths, probes, means)
   update_manifest(DATA_DIR, {"scene_id": scene_id, "role": "...", "status": "real", "title": "...",
                              "context": "...", "source_url": "...", "product": "...",
                              "bands_used_nm": bands, "f0_source": "..."})
   ```
   `export_scene_example()` at the bottom of `export_contract.py` is a fill-in-the-blanks version.
9. **Validate:** run `python pipeline/validate_contract.py data`. Fix every FAIL and read every WARN.

## Reference spectrum

- **Source:** the Korean field study the team selected, with measured reflectance of *M. polykrikoides* blooms.
- **Digitizing:** if it's only in a figure, digitize it carefully, and note the bloom density and date.
- **Writing it:** use `write_references()`. Include the full citation in `source` and replace the mock **PLACEHOLDER** entry.
- **Wrong form of Noctiluca:** don't add a *Noctiluca* reference measured in Korea. Korean *Noctiluca* blooms are usually the red form, which is optically different from the green form found in the Arabian Sea.

## Traps we already know about

| Trap | What happens | Fix |
|---|---|---|
| Latitude south → north | The map is upside down | `orient_grid()`; the validator warns about it |
| nflh in W m⁻² µm⁻¹ sr⁻¹ | Everything looks like a bloom | Use contract units (÷10), or compute from Rrs × F0 in mW cm⁻² µm⁻¹ |
| PACE has no 748 nm Rrs | The FLH baseline is different | Use about 717 nm and log it in `bands_used_nm`; mention it in the pitch |
| PACE V3 drops 590–610 nm | A gap in the spectra | Leave those bands out of `wavelengths_nm` |
| Dust or muddy water | Fake high red/blue ratios | Keep both rule conditions; mask by flags |
| Shallow, bright seabed | Fake signals near the coast | `shallow` mask from bathymetry |
| Values right at a threshold | Class and shown value disagree | `classify()` compares rounded values; don't classify another way |
| Level-2 swath data | Not a regular grid | Bin or resample to a regular lat/lon grid before `orient_grid()` |

## What to tell the interface after each export

- The `scene_id` and whether it replaced a mock scene
- The validator result, including warnings
- Anything unusual: a large cloud gap, a low-confidence date, or a band choice that differs from the plan

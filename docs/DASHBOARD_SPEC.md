# Dashboard spec

This spec describes **what the dashboard must do**, not how it should look. Layout, visual design and structure are up to whoever builds it (see the hard rules in `CLAUDE.md`). The data it reads is defined in `DATA_CONTRACT.md`.

## Design brief

- **Audience:** hackathon judges (on a projector and on their phones), then desalination and fish-farm operators.
- **The map is the hero.** Every flag must be explainable in one click.
- **Make it look like a product, not a generic admin template.** It should be calm and trustworthy, like a scientific instrument, but approachable.
- **Honesty is part of the design.** The evidence level, mock labels and limits are visible, not buried.

## Must-have features (acceptance criteria)

1. **Scenes.**
   - Pick any scene in `manifest.json`, grouped by region.
   - Show each scene's title, date, sensor, role (as a clear evidence-level label), context, source link, product and `bands_used_nm`.
   - Step to the previous or next scene in the same region.
2. **Class layer.** `grid.json` classes drawn on the map, accurately positioned (see the technical notes). Land is transparent; `no_data` and `shallow` are visibly distinct from water.
3. **Value layers.**
   - `ratio_667_443`, `nflh` and (when present) `sam_deg` as color scales.
   - The scale's threshold is taken from `manifest.rule` and visibly marked in the legend.
   - The ratio works best as a diverging scale centered on its threshold.
4. **Explain a pixel.** Clicking any pixel shows:
   - its class
   - its coordinates and the scene date
   - each rule check, with the value, the threshold and **pass or fail in words**
   - `sam_deg` labeled as supporting only, when present
   - for masked pixels (codes 0–2), why they weren't tested
5. **Spectrum chart.**
   - It shows the clicked pixel's stored spectrum (the nearest probe within about 1.5 cells), or its class average when none is stored, together with the reference spectrum, and say which it is.
   - Hover readout.
   - It handles PACE's 590–610 nm gap (break the line) and MODIS's few discrete bands (connect them and mark each band).
   - Optional "compare shapes" mode that normalizes each line to its own peak.
6. **Watched sites.**
   - Sites from `sites.geojson` for the current region, on the map and in a list.
   - Each has an Alert, Watch, Clear or Unknown status, computed in the browser (contract section 10), plus the distance to the nearest `cp_like` cell.
   - Status is never shown by color alone.
   - Clicking a site zooms to it and explains its status.
7. **True-color photo** of the scene date (NASA GIBS) as a toggle under the overlay, with an overlay opacity control.
8. **About and limits:** the validation plan and limits from `PROJECT.md`, in plain language.
9. **Mock data badge** whenever the current scene's `status` is `mock`.
10. **Robustness.** Friendly messages for:
    - a missing or invalid file
    - a contract major version this app doesn't support
    - a scene without `spectra.json` or without `sam_deg`
    - opening the app from disk instead of a server

    One bad scene must not break the others.
11. **Responsive:** usable on a phone (360–430 px wide, no sideways scrolling) and on a laptop.
12. **Shareable state:** the URL keeps the selected scene, e.g. `#scene=korea_pace_20260810`.

## Nice to have (only after every must-have works)

- Animating through a region's scenes over time (the 2008 bloom spreading)
- Comparing two scenes side by side, or with a swipe
- An Arabic/English language toggle (the event is in the UAE)
- A printable one-page site report: status, map snapshot, evidence, date
- Dark mode
- A "How the rule works" explainer: a small interactive showing the two checks on a spectrum

## Technical notes (these will save you time)

- **MapLibre GL JS v6 is ESM-only** (there's no UMD `maplibre-gl.js` in v6). Use `import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs'` plus its CSS, or install from npm. Pin the version.
- **Draw the grid at its true position.** A MapLibre `image` source maps its four corners linearly in Web Mercator. A lat/lon grid stretched that way is misplaced by up to about **9 km** in the middle of the Gulf box. Either:
  - render the grid to a canvas whose rows are resampled at their Mercator positions (for each output row: Mercator y → latitude → source row), or
  - reproject in some other way.

  Use `raster-resampling: 'nearest'` so class pixels stay crisp.
- **Click → cell:** `col = floor((lon − west) / res_lon)`, `row = floor((north − lat) / res_lat)`, `index = row * width + col`.
- **Text on the map:** symbol layers need a `glyphs` URL in the style. Without one, use HTML popups or markers for any text.
- **Basemap:** use one without place labels, e.g. CARTO `https://{a-c}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png` (or `dark_nolabels`), credited "© OpenStreetMap contributors © CARTO". Label sets often name the sea differently from the hackathon's framing ("Arabian Gulf"); if you need labels, draw your own.
- **NASA GIBS true color** (free, no key):
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, `maxzoom: 9`.
  Use `MODIS_Aqua_CorrectedReflectance_TrueColor` for 2008 and `VIIRS_NOAA20_CorrectedReflectance_TrueColor` for recent dates. Verify both names in the GIBS layer list, and make the choice easy to change.
- **Local server:** `fetch()` needs one (e.g. `python -m http.server`, or your dev server). Opening `index.html` from disk fails; detect this and say so.
- **File sizes:** `grid.json` is about 0.7–1.1 MB per scene. Load on demand and cache.
- **Numbers:** show values with the contract's decimals. The pipeline classifies on rounded values, so the shown numbers and the class always agree.
- **Colors:** if you pick your own class colors, check them for colorblind safety. A validated starting set: clear `#5598e7`, bloom_other `#eda100`, cp_like `#d03b3b`, no_data `#898781`, shallow `#c3c2b7`. For value layers, use one-hue sequential scales, and a two-hue diverging scale with a neutral midpoint.
- **Site distances** are on the order of tens of km. An equirectangular approximation is fine; only scan cells within the watch radius.

## How to check your work

1. Run `python pipeline/make_mock_data.py`, then `python pipeline/validate_contract.py data`, and confirm PASS.
2. Run the app and open each mock scene. Confirm the browser console has **zero errors**.
3. Drive it in a headless browser if one is available (e.g. Playwright) and take screenshots at about 1440 × 900 and 390 × 844:
   - Click a `cp_like` pixel: both checks pass, and the values match `grid.json` at that index.
   - Click a `bloom_other` pixel: the ratio check fails.
   - Click land, `no_data` and shallow pixels: each shows its reason.
   - Switch to the Korea scene: the sites list shows Alert or Watch statuses.
   - Switch value layers: the threshold appears in the legend.
4. Check the overlay position against coastlines (the true-color layer, or the land pixels against the basemap).
5. Break a copy of `grid.json` (wrong length, wrong `contract_version`) and confirm the message is friendly and the other scenes still work.
6. Re-read the must-have list above before calling a phase done.

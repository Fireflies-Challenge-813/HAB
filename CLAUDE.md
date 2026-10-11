# Gulf Bloom Watch

This is a satellite early-warning dashboard for *Cochlodinium (Margalefidinium) polykrikoides*-like harmful algal blooms in the Arabian Gulf and Sea of Oman, built for the Arab Youth Space Hackathon 2026 (Challenge 813). It has two parts:

- **A static website** (the dashboard), owned by Manar
- **A small Python pipeline** that writes the data files the website reads, owned by the data team

## Context loaded every session

- What we're building, why, the decisions we've made and the known limits: @docs/PROJECT.md
- The data contract (exact file names, fields, units, class codes, grid layout): @docs/DATA_CONTRACT.md

## Read before the matching work

- **Building or changing the dashboard:** read `docs/DASHBOARD_SPEC.md` first. It has the requirements, the design brief, technical notes and the checks.
- **Working on satellite data or the pipeline:** read `docs/PIPELINE_GUIDE.md` first.

## Hard rules (ask Manar before breaking any of these)

1. **The data contract is the only interface** between the pipeline and the dashboard. Never rename or re-type a field, unit, class code or file path. To change it, propose the change with a `contract_version` bump (see the versioning section of the contract).
2. **MapLibre GL JS** (v6) is the map engine.
3. **Static site only.** It must build to static files deployable on GitHub Pages or Netlify: no backend, database, API keys or paid services.
4. **Thresholds come from `data/manifest.json`** (`rule`). Never hard-code `5`, `10`, `0.25` or any other threshold in the web app.
5. **Honesty:**
   - Say "*C. polykrikoides*-like", never "toxic".
   - Show every scene's evidence level (its `role`).
   - Present confidence as a separation score, never as a probability.
   - Visibly label any scene with `status: "mock"`.
   - Keep the limits from `docs/PROJECT.md` reachable in the UI.
6. **Ownership:**
   - Never edit `data/scenes/*` files whose scene has `status: "real"`; they belong to the data team.
   - `data/sites.geojson` is Manar's: real sites, each naming its source. Change it only when Manar asks.
7. **Everything else is your call:** layout, visual design, interaction, project structure, build tooling and extra features. There's no earlier prototype to follow. Aim for a distinctive, polished product.

## Repo layout

```
CLAUDE.md                  this file
README.md                  for humans: what's here and how to run it
docs/
  PROJECT.md               idea, hackathon, decisions, limits, glossary
  DATA_CONTRACT.md         the pipeline ↔ dashboard contract
  DASHBOARD_SPEC.md        what the dashboard must do
  PIPELINE_GUIDE.md        how to produce real data files
pipeline/
  export_contract.py       writes files in contract format (data team uses this)
  validate_contract.py     checks data/ against the contract (stdlib only)
  import_map_export.py     turns the data team's map export (GeoTIFF grids + JSON) into data/
  make_mock_data.py        generates mock data into mock-data/ through export_contract.py
  mock_depth_gebco.json    real GEBCO depths sampled every 0.02° for the mock (--fetch-depth)
  requirements.txt
data/                      contract files: the real data (generated, not hand-written)
mock-data/                 mock data for the full check suite (generated; not shipped)
web/                       the dashboard (Vite + MapLibre GL JS, plain ES modules)
  index.html               page shell
  src/                     main.js (app), contract.js (load + check data), map.js,
                           grid-image.js (overlay tiles drawn from the grid), timeline.js,
                           sections.js (foldable details
                           sections; the rail that replaces each panel's scrollbar), more.js (expandable
                           explanations and the folding checklist), tip.js (hover explanations),
                           measure.js (right-click menu and dock button: measure distance and area),
                           compare.js (swipe compare: the divider and the second map),
                           places.js (UAE and Oman city names), about.js (About and limits),
                           chart.js (spectrum chart), inspector.js (pixel details and checklist),
                           sites.js (site statuses by sea),
                           currents.js (currents field, bloom patches, drift tracks), flow.js (animated
                           current particles), format.js, styles.css
  public/land.geojson      land polygons for every area box (cut out of the data image)
  public/currents/         surface currents per scene date over its area (Open-Meteo), plus index.json
  scripts/check.mjs        full headless checks on the mock data, in the installed Chrome, Edge and Avast
  scripts/check-real.mjs   headless checks on the real data, in Chrome
  scripts/make-land.mjs    rebuilds public/land.geojson from the basemap's tiles
  scripts/fetch-currents.mjs  fetches public/currents/ from Open-Meteo (no key)
  vite.config.js           serves ../data (../mock-data in mock mode) and MapLibre's files; copies data/ and them into dist/
```

## Commands

```bash
pip install -r pipeline/requirements.txt      # numpy, global-land-mask
python pipeline/import_map_export.py <export folder>   # the data team's export -> data/
python pipeline/validate_contract.py data      # must end with PASS
python pipeline/make_mock_data.py              # (re)generate mock data into mock-data/
python pipeline/make_mock_data.py --fetch-depth   # once: re-sample GEBCO depths (~8 min, needs internet)
python pipeline/validate_contract.py mock-data # must end with PASS
```

Dashboard (run inside `web/`):

```bash
npm install                                    # once
npm run dev                                    # dev server at http://127.0.0.1:5173/ (the real data)
npm run dev:mock                               # dev server at http://127.0.0.1:5174/ (the mock data)
npm run build                                  # static site in web/dist (includes data/)
npm run preview                                # serve web/dist at http://127.0.0.1:4173/
npm run check                                  # full headless checks on the mock data; needs dev:mock running
npm run check:real                             # headless checks on the real data; needs dev running
npm run land                                   # rebuild land polygons after the area boxes change (needs internet)
npm run currents                               # fetch surface currents for new dates or areas (~1 min per date, needs internet)
```

Deploy: GitHub Pages, by `.github/workflows/pages.yml` on every push to main (it runs `npm run build` in `web/` and publishes `web/dist`). The site: https://fireflies-challenge-813.github.io/HAB/

## Current task: build the dashboard

Follow `docs/DASHBOARD_SPEC.md`. Suggested phases:

0. **Orient.**
   - Read `docs/DASHBOARD_SPEC.md`.
   - Run the mock-data generator and the validator, and confirm PASS.
   - Give Manar a short concept: the layout idea, the stack and the phase plan, a few lines each. Wait for a go-ahead, unless Manar has said to work autonomously.
1. **Core:** app scaffold, loading and checking the contract files, the map with the class layer, the scene picker and the timeline.
2. **Explanation:** pixel details with the chlorophyll and cluster checks, the chlorophyll layer, the spectrum chart, watched sites and the true-color toggle.
3. **Finish:**
   - Mobile layout, the About and limits content, and friendly error states.
   - A README with run, deploy and troubleshooting steps.
   - A GitHub Pages deploy.

Commit at the end of each phase with a clear message. Update the "Commands" and "Repo layout" sections of this file as things change.

## Before saying something is done

- `python pipeline/validate_contract.py data` prints PASS.
- The app runs with **zero console errors**.
- You checked it at desktop and phone widths. Use headless-browser screenshots (e.g. Playwright) if available; otherwise say clearly what you couldn't check.
- Clicking a `cp_like` pixel shows checks that match the stored values.
- You re-read the acceptance criteria in `docs/DASHBOARD_SPEC.md` and they still hold.

## Conventions

- Data field names stay exactly as in the contract (snake_case). Don't map them to other names across the codebase; use them directly.
- Display numbers with the contract's decimals (chlorophyll 2, nflh 4, spectral angle 2, margin 2, depth in whole metres).
- Statuses and classes are never shown by color alone; always pair them with a word or icon.
- Cite sources in the UI where the manifest provides them (`source_url`, `rule.citation_url`).
- Keep dependencies few, free and well maintained. Pin versions.

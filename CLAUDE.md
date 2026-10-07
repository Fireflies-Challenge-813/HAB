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
4. **Thresholds come from `data/manifest.json`** (`rule`). Never hard-code `1.0`, `0.04` or any other threshold in the web app.
5. **Honesty:**
   - Say "*C. polykrikoides*-like", never "toxic".
   - Show every scene's evidence level (its `role`).
   - Visibly label any scene with `status: "mock"`.
   - Keep the limits from `docs/PROJECT.md` reachable in the UI.
6. **Ownership:**
   - Never edit `data/scenes/*` files whose scene has `status: "real"`; they belong to the data team.
   - `data/sites.geojson` is Manar's. Keep the example sites until Manar replaces them.
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
  make_mock_data.py        generates mock data through export_contract.py
  requirements.txt
data/                      contract files (generated, not hand-written)
<web app>                  your choice; record its location here once created
```

## Commands

```bash
pip install -r pipeline/requirements.txt      # numpy, global-land-mask
python pipeline/make_mock_data.py              # (re)generate mock data into data/
python pipeline/validate_contract.py data      # must end with PASS
```

Dashboard commands: **TODO.** Add the dev, build, preview and deploy commands here as soon as the web app exists.

## Current task: build the dashboard

Follow `docs/DASHBOARD_SPEC.md`. Suggested phases:

0. **Orient.**
   - Read `docs/DASHBOARD_SPEC.md`.
   - Run the mock-data generator and the validator, and confirm PASS.
   - Give Manar a short concept: the layout idea, the stack and the phase plan, a few lines each. Wait for a go-ahead, unless Manar has said to work autonomously.
1. **Core:** app scaffold, loading and checking the contract files, the map with the class layer, and the scene picker.
2. **Explanation:** pixel details with the rule checks, value layers, the spectrum chart, watched sites and the true-color toggle.
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
- Display numbers with the contract's decimals (ratio 3, nFLH 4, spectral angle 1).
- Statuses and classes are never shown by color alone; always pair them with a word or icon.
- Cite sources in the UI where the manifest provides them (`source_url`, `rule.citation_url`).
- Keep dependencies few, free and well maintained. Pin versions.

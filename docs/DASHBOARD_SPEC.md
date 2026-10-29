# Dashboard spec

This spec describes **what the dashboard must do**, not how it should look. Layout, visual design and structure are up to whoever builds it (see the hard rules in `CLAUDE.md`). The data it reads is defined in `DATA_CONTRACT.md`.

## Design brief

- **Audience:** hackathon judges (on a projector and on their phones), then desalination and fish-farm operators.
- **The map is the hero.** Every flag must be explainable in one click.
- **Make it look like a product, not a generic admin template.** It should be calm and trustworthy, like a scientific instrument, but approachable.
- **Honesty is part of the design.** The evidence level, mock labels, confidence caveats and limits are visible, not buried.
- **Layout:** the map fills the screen and everything else floats over it: a top bar (scene title, evidence level, mock label; the date is on the timeline), the legend at top left, watched sites at bottom left, details on the right and a see-through timeline along the bottom.
- **Side panels:** the legend, watched sites and details each have a small tab with an arrow on their inner edge that slides the panel off to its side; the tab stays at the screen edge, with the panel's name (and, for sites, the number on Alert), to bring it back. Clicking the map or a site brings the details back. On a phone only the legend floats, so only it slides (and it starts slid away).
- **Rails:** in all three panels a rail replaces the scrollbar: one segment per item (details section, site, legend group), colored by its risk where it has one, and a frame over the part in view. Names show only while the pointer is on the rail (all of them in the details panel; the one under the pointer in the longer lists); clicking goes there.
- **Details sections:** each section (pixel, cluster spectrum, site, scene, pixel census) has a header bar ending in an arrow button (up: hide, down: show); clicking the bar folds it to a one-line summary, and it stays folded across dates. A folded pixel card keeps its class and its risk tier, in the tier's color.
- **Short by default:** text that reads the same every time (what a flag means, how the margin is worked out, what an evidence level means) shows its first line, with an arrow button on its right that unfolds the rest. Only the arrow opens it, never a click on the text. What the viewer opened stays open. The surface-current notes (in the pixel details and the legend) don't unfold: their explanation shows in a small window, styled like the panels, right beside the pointer on hover (on focus, or a tap on a touch screen). Buttons that fold and unfold show only an arrow, with a label for screen readers. The chlorophyll and nFLH scales carry no description under them.
- **Style: data-dense modernism.** Neutral gray chrome, hairline rules, mono tabular numbers. Hue is reserved for data: the class palette and the chlorophyll scale, with risk tiers and site statuses taking the color of the class that defines them.

## Must-have features (acceptance criteria)

1. **One window, one timeline.**
   - The map shows the **whole area of the selected date in one window** (like NASA Worldview), fitted into the part of the screen not covered by panels, and dims everything outside it. Only that area's box is outlined, so the test area's border shows on the test date alone (a day without data keeps the last area shown). The held-out test date has its own area (contract section 4): picking it fits the map to that area, unless the view is already inside it; going back fits the main area again. Otherwise changing the date keeps the map view.
   - **A continuous timeline,** like NASA Worldview's: year, month and day fields with steppers, one-day arrows, a button that jumps to the next date with data (the next event, >|), and an axis spanning whole years. A zoom toggle (year, month or day, between up and down arrows) sets the axis scale, with the role key beside it. Every date in `manifest.json` sits at its true place in time, marked in a coverage strip and by its role. The selected day has a draggable handle. Any day can be picked, so the timeline works for whatever dates the data has.
   - An arrow at the right end **folds the timeline** down to the date fields, the one-day arrows and the next-event button; the same arrow unfolds it.
   - The selected date draws **every scene with that date**. A day without a scene says so, offers the nearest dates with data, and its sites show Unknown.
   - The map outside the area is dimmed (over the basemap and the true-color photo), so the area reads as the focus.
   - Show each scene's title, date, role (as a clear evidence-level label, plus the note for held-out test dates), context, source link and products.
2. **Class layer.** `grid.json` classes drawn on the map, accurately positioned (see the technical notes). Land is transparent; `no_data` is visibly distinct from water. `shallow` is hatched over the water beneath it and labeled **not assessed**: it means "not trusted enough to name a species", not "no bloom". The legend groups classes by **risk tier**, highest first (High, Watch, Monitor, Low, No flag, Not assessed), and pairs every color with a word.
   - **Class colors** (the agreed hues): grey no data, blue non-bloom water, yellow weak bloom, light orange unclassified dense bloom, red *C. polykrikoides*-like, dark orange *Noctiluca*-like, green diatom-like; shallow water is hatched and land isn't drawn. The shades are picked so every pair stays apart under colour-blindness simulation.
   - **Clean coastline:** land polygons (from the basemap's own tiles) are cut out of the data image, so whatever lies beneath shows on land: the basemap, or the true-color photo. It is display-only: classes, clicks, census and site statuses still use every cell. A toggle shows the raw pixels at the coast.
3. **Chlorophyll layer.** `chlor_a` on a logarithmic color scale from 0 to 20 mg m⁻³ (20 and above in the top color; positions follow log(1 + value ÷ 0.1), so the scale can start at 0), running dark blue → light blue → green → yellow → red (stops at 0, 0.3, 1, 3, 10 and 20, as agreed with the data team), with `chl_weak_min` and `chl_dense_min` from `manifest.rule` marked on the legend. Hovering the map marks the pixel's value on the legend's scale, in a box filled with the scale's color at that value. Shallow-water pixels show their chlorophyll too, as on NASA's maps, hatched, where the pipeline keeps it.
3b. **Fluorescence (nFLH) layer,** the third layer option. Switching between Classes, Chlorophyll and nFLH slides the dark marker to the chosen button and slides the legend in from that side. `nflh` on a linear scale from 0 to 0.8 (above in the top color), with a sharp step in the colors at `rule.nflh_dense_min`: muted navy and slate below it, magenta through orange to pale yellow above it, so raised fluorescence stands out. The legend marks the threshold ("raised 0.2479"), hovering marks the value on the scale, the readout gives the value, and shallow pixels are hatched, as on the chlorophyll layer. On both value layers, the readout beside the coordinates shows the value in a box of the color the map shows it in, then the class in words.
4. **Explain a pixel.** Clicking any pixel shows:
   - its class and risk tier
   - its coordinates and the scene date
   - its own values: chlorophyll, nflh, depth (from the area's depth file, when present) and density (no bloom, weak or dense)
   - the checks, in order: chlorophyll against the weak and dense gates, nflh against `nflh_dense_min`, the closest reference being a bloom, the margin, and the two comparisons (shape and pigment features) picking the same reference, each with the result **in words**. All six checks sit in a **class precedence checklist**, right under the pixel's values and set off by a heavy rule as the card's main explanation. It starts folded to a strip of the six numbered checks in order, colored by result (green pass, red fail, gray not reached; no ticks or crosses), beside their tally in words, and opens from its bar. Opened, each check's number sits in a square of the same color, with its result in words on the right. The notes on what can affect the result (shallow water, turbid water, the surface current) close the card, under the cluster
   - for codes 3–8, its cluster: whether the closest reference is a bloom, the angle to every reference by shape and by pigment features (the second derivative), 2 decimals, the best and second-best match, the margin worked out from the shown angles and the gap between the two references ((2nd − best) ÷ gap = margin), against `margin_min`, and the confidence band, labeled as a **separation score, not a probability**
   - **flags on top of the class**, as square status tags under the risk tier (an amber edge, an icon and a word), each with its note (contract section 6): shallow 5–15 m, turbid water. A folded card keeps one caution mark
   - for masked pixels (codes 0–2), why they weren't tested; for shallow pixels also the reading and the depth when stored (otherwise it says no readings are stored)
   - for codes 3–8 at least `shallow_max_m` and under `shallow_flag_max_m` deep (by the area's depth file), a warning that the seabed may affect the result; the folded card keeps a caution mark
5. **Spectrum chart.**
   - Shows the clicked pixel's **cluster mean spectrum**, the curve that was compared with the references. Without cluster details, it falls back to the pixel's stored spectrum (the nearest probe within about 1.5 cells) or the class average, and says which.
   - Overlays the best and second-best reference spectra, with an option to show all six.
   - Normalizes each line to its own peak by default ("compare shapes"), because SAM compares shape, not brightness; raw values are one click away. Curves stored scaled to unit length (`units: "normalized"`) are labeled so, and an axis that dips below zero (over-corrected blue bands) shows the zero line.
   - Shades the bands the shape comparison leaves out (below `rule.sam_range_nm`) and says so.
   - Says beside the chart how well the cluster matches ("*C. polykrikoides*-like, confidence 0.60 (Medium)") or why it isn't named.
   - Hover readout.
   - Handles PACE's 590–610 nm gap (break the line).
6. **The held-out test date.**
   - Its scene card shows the context (with the test result) and every source link (`source_url` and `links`: NASA Earth Observatory and Copernicus).
   - Its census shows the true-negative check: how its dense-bloom pixels were named (*C. polykrikoides*-like, *Noctiluca*-like, diatom-like, unclassified, each as a share), passing when none is *C. polykrikoides*-like, labeled as a true-negative check only.
7. **Watched sites.**
   - Sites from `sites.geojson`, on the map and in a list.
   - Each has an Alert, Nearby, Clear or Unknown status, computed in the browser from the date's grid that reaches it (contract section 10), plus the distance to the nearest `cp_like` cell. A site no grid of the date reaches is Unknown, "outside this date's area". Distances are by sea, around land: the shortest path through water cells (a grid search, using the straight line wherever it stays over water).
   - Status is never shown by color alone.
   - Clicking a site zooms to it and explains its status. When the nearest `cp_like` cell lies in flagged shallow water, the explanation says the seabed may affect it. The details also name the location's source and say when it is approximate.
   - One toggle per site type (desalination plants, fish farms, beaches) shows or hides that type on the map and in the list. The choice is remembered in the browser.
   - **Map controls:** a small dock to the right of the timeline, as tall as it, in MapLibre's button style: zoom in over zoom out at the far right, and to their left the city-names button over the measure button. The scale and the attribution (i) sit bottom right, above the timeline, and move all the way right when the details panel is slid away.
   - **Site-type toggles** (desalination, fish farms, beaches) hang outside the sites panel in a column under its tab, sharing its width. Their place never changes: they start where the tab ends when the panel is slid away (the tab then has one fixed height, with room for the alert count) and keep that place when the panel is shown, under the shorter tab. They slide with the panel and stay at the screen edge when it is away, so the alerts can be filtered either way. Each hides or shows that type on the map and in the list. On a phone they sit in a row under the sites header.
   - The sites panel keeps one height, so switching site types off (even all of them) never moves it or its toggles.
   - **City names:** UAE and Oman cities and towns, down Oman's Arabian Sea coast to Duqm (OpenStreetMap place points), a dot at each with its name beside it, over the site markers but not catching clicks. The big cities show at the starting view; towns join as you zoom in. The dock's names button hides and shows them, and the choice is remembered.
8. **True-color photo** of the selected date (NASA GIBS) as a toggle under the overlay, with an overlay opacity control. With the photo on, non-bloom water is left clear so the real water shows.
9. **About and limits:** a panel opened from the top bar with the method (thresholds and band ranges read from the manifest, the fit from `clusters.json`), what each evidence level means, the site statuses, what the real data shows (the results in `PROJECT.md`; hidden while mock data shows), the limits from `PROJECT.md`, the next steps and the sources, in plain language.
10. **Mock data badge** whenever the current scene's `status` is `mock`.
11. **Robustness.** Friendly messages for:
    - a missing or invalid file
    - a contract major version this app doesn't support
    - a missing `clusters.json` (classes still draw; the explanation says the cluster details are unavailable)
    - a scene without `spectra.json`, and an area without a depth file
    - opening the app from disk instead of a server

    One bad scene must not break the others.
12. **Responsive:** usable on a phone (360–430 px wide, no sideways scrolling) and on a laptop. On a phone the first screen is the full map with the top bar, legend and timeline; sites and details follow below.
13. **Shareable state:** the URL keeps the selected date, e.g. `#date=2025-03-24`, and an open comparison, e.g. `&compare=2024-12-09,chl`. A date outside the timeline falls back to the latest date with data, with a notice.
14. **Light and dark modes.** Follow the system setting, with a toggle in the top bar. The basemap and map chrome switch with the theme; data colors stay the same in both. In light mode the pointer keeps the system's shapes (the arrow, the hand and, over the map, the crosshair) but in dark, since the system's light ones fade on the light map and panels; dark mode keeps the system's. The map credits stay on one line on a wide screen.
15. **Surface currents** (a legend toggle, on by default).
    - Animated particles with fading trails, in the style of Ventusky, follow the day's **net** surface current (the 24-hour mean, tides averaged out), over either layer. With "reduce motion" set, still arrows replace them.
    - From each *C. polykrikoides*-like patch (dashed) and each green *Noctiluca*-like patch (dotted), a track shows where surface water would drift in 48 hours, following the hourly currents (tides included) from 09:00 UTC, about the satellite's pass. A dot marks 24 h, a ring 48 h and a cross where a track meets the coast.
    - A clicked pixel's details give the current there (km/h, direction, net over the day) and, inside a tracked patch, its drift distance and direction at 24 and 48 hours.
    - Always worded as a model estimate: wind, the algae's own swimming, growth and decay aren't included. Site statuses don't use it.
    - A date without prepared currents says so and the toggle is disabled.
    - Wherever the date has currents, the hover readout also gives the net current under the cursor (an arrow toward where the water flows, and the speed), even with the layer off.
16. **Measure distance and area,** as in Google Maps. Right-click the map (press and hold on a touch screen) for a menu: the coordinates there (click to copy), **Measure distance** and **Measure area** (and **Clear measurement** while measuring).
    - The dock's measure button opens the same two measures above it; measuring then starts from the first click, the button stays pressed, and pressing it again ends the measurement.
    - The right-clicked spot is the first point; each click adds one. Click a point to remove it, drag it to move it, Backspace removes the last; Esc or the card's close button ends it. While measuring, clicks don't pick pixels.
    - Distances are great-circle (km, and nautical miles for the sea); an area is the spherical area of the closed shape (km²) with its perimeter. A card at the top right of the map gives the result, and a label beside the last point the running total.

17. **Swipe compare.** A Compare button beside the legend's layer switch puts a vertical divider on the map: left of it (A) the selected date and layer, right of it (B) a second date and reading.
    - B's date (every date with data, with arrows) and reading (Classes, Chlorophyll, nFLH, or that date's true-color photo with its credit) are picked in a bar at the bottom of the map, which also swaps A and B and closes the comparison. B starts on the date before A, with A's layer.
    - Drag the divider (mouse or finger), or focus its handle and use the arrow keys (Home and End jump to the edges of the open map).
    - The hover readout gives both sides at the cursor, each tagged A or B, marking the side under it. A clicked pixel's details stay on A and add a line with B's class and values at the same cell; swapping gives B's full details.
    - When B shows another layer, the legend explains both. The timeline tags B's date.
    - B follows A's camera, overlay opacity, clean coastline and true-color settings, and shows the same measurement and selected cell. B can be a date in another area. Whenever either side is on the held-out test date, B outlines and keeps clear the test area; otherwise B shows its own date's area. Site markers, currents and drift tracks belong to A; city names show on both sides.
    - On a phone, Compare slides the legend away and the bar spans the map above the timeline.

## Nice to have (only after every must-have works)

- Playing the timeline as an animation
- A change map between two dates (new bloom, gone, persisting; chlorophyll up or down), and a pixel's history over every date
- An Arabic/English language toggle (the event is in the UAE)
- A printable one-page site report: status, map snapshot, evidence, date
- A "How naming works" explainer: a small interactive showing the density gate and the margin on a spectrum

## Technical notes (these will save you time)

- **MapLibre GL JS v6 is ESM-only** (there's no UMD build in v6). It starts its worker from a file beside its own module, so serve its `.mjs` files unbundled. Pin the version.
- **Draw the grid at its true position.** Draw the overlay as raster tiles generated in the browser (a custom `addProtocol` source): for each tile pixel, Mercator → longitude and latitude → the grid cell, with the same arithmetic as a click. Cells then sit on their true edges at every zoom, under the selection box. A single stretched `image` source can't do this: MapLibre maps it linearly in Mercator (grid rows aren't evenly spaced there) and rounds its corners to a coarse grid, so cells drift by a fraction of a cell. Use `raster-resampling: 'nearest'` so class pixels stay crisp.
- **Click → cell:** `col = floor((lon − west) / res_lon)`, `row = floor((north − lat) / res_lat)`, `index = row * width + col`.
- **Text on the map:** symbol layers need a `glyphs` URL in the style. Without one, use HTML popups or markers for any text.
- **Basemap:** use one without place labels and without an API key, e.g. OpenFreeMap vector tiles (`https://tiles.openfreemap.org/planet`) styled with land, water and borders only, credited "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
- **NASA GIBS true color** (free, no key):
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, `maxzoom: 9`.
  Use `VIIRS_NOAA20_CorrectedReflectance_TrueColor` (verify the name in the GIBS layer list, and make the choice easy to change).
- **Local server:** `fetch()` needs one (`npm run dev` or `npm run preview`). Opening `index.html` from disk fails; detect this and say so. Python's `http.server` on Windows serves `.mjs` with the wrong type, so MapLibre won't load from it.
- **File sizes:** `grid.json` is about 9 MB per scene (about 0.8 MB compressed when served). Load on demand and cache. Each area's depth file (about 2 MB) loads once in the background. `clusters.json` and `references.json` are small; load them once.
- **Numbers:** show values with the contract's decimals (chlorophyll 2, nflh 4, angles 2, margin 2, depth in whole metres). The pipeline classifies on rounded values, so the shown numbers and the class always agree.
- **Colors:** check class colors for colorblind safety, keep red (*C. polykrikoides*-like), dark orange (*Noctiluca*-like), light orange (dense unclassified) and yellow (weak) visibly different from each other, and keep tier text at 4.5:1 contrast or more. The chlorophyll layer uses the agreed blue → green → yellow → red scale; it is never shown at the same time as the class layer.
- **Surface currents** come from files prepared once by `npm run currents` (`web/scripts/fetch-currents.mjs`): the Open-Meteo Marine API (free, no key; Météo-France SMOC, hourly, about 8 km, tides included), sampled every 0.25° over the water of each date's own area box, 72 hours from 00:00 UTC of each scene date, in `web/public/currents/` with an `index.json`. The site makes no live API calls, so the demo can't hit Open-Meteo's rate limits. Rerun the script when the scene dates or areas change. Land polygons for every area box come the same way, once, from `npm run land` (`web/public/land.geojson`).
- **Site distances** are on the order of tens of km. An equirectangular approximation is fine; only scan cells within the 75 km radius.
- **Swipe compare** uses a second, non-interactive MapLibre map inside the main one, after its canvas and before the DOM markers, clipped with `clip-path` right of the divider. It follows the main map's camera on every move. The overlay tile protocol is global to MapLibre, so it is registered once and keyed by map and area. Closing the comparison removes the second map, freeing its WebGL context.

## How to check your work

1. Run `python pipeline/validate_contract.py data` (the real data) and `python pipeline/validate_contract.py mock-data` (the mock data from `python pipeline/make_mock_data.py`), and confirm PASS for both.
2. Run the app and open each scene. Confirm the browser console has **zero errors**. In `web/`: `npm run dev:mock` then `npm run check` runs the full suite on the mock data (it has every class) in Chrome, Edge and Avast; `npm run dev` then `npm run check:real` checks the real data in Chrome.
3. Take screenshots at about 1440 × 900 and 390 × 844 and check:
   - Click a `cp_like` pixel (mock data; the real data has none, so click a *Noctiluca*-like one there): chlorophyll ≥ the dense gate, margin ≥ `margin_min`, best match = the named reference by both comparisons, and the values match `grid.json` and `clusters.json`.
   - Click a `dense_unclassified` pixel: the bloom-reference, the margin or the two-comparisons check fails.
   - Click a `weak_unclassified` pixel: the dense chlorophyll or the fluorescence check fails.
   - Click land, `no_data` and shallow pixels: each shows its reason; shallow also shows "not assessed", with its reading and depth when stored.
   - Click a pixel 5–15 m deep: the seabed warning and its "Shallow 5–15 m" chip show. A deeper pixel has neither. Click a turbid plume pixel (non-bloom, chlorophyll 10 or more): the "Turbid water" tag and the sediment note show. The notes and the checklist start folded; only their arrows open them. Hovering the surface-current note shows its explanation by the pointer.
   - Right-click the map, pick Measure distance, click two more points: the card's total matches the great-circle distance, and no pixel is selected. Measure area on three points gives the area and perimeter. Esc ends it.
   - Pick the held-out date: the map fits its own area, its census shows the true-negative check, and its sources link NASA and Copernicus.
   - Use the timeline: dates with data sit in time order, the arrows, fields and next-event button change the date, the map view stays put within an area, the URL updates. Pick a day without data: it says so. Step the zoom toggle, then fold and unfold the timeline.
   - Fold and unfold the details sections; a folded pixel card still shows its risk tier. Jump to a section from the rail. Slide each panel away by its tab and back.
   - Scroll the details to the spectrum, then click another pixel: the details stay at the spectrum. Toggle the true-color photo: the legend doesn't jump.
   - Zoom right in on the corner of a bloom patch: its color changes exactly at the cell edges.
   - On the chlorophyll layer, hover the map: the legend's scale marks the value, in a box of that value's color.
   - Switch each site type off and on with its toggle under the sites tab: its markers and list entries go and come back, and the panel doesn't move, even with every type off. Slide the panel away and back: the toggles stay in place.
   - Open Compare: drag the divider, change B's date and reading, hover both sides, swap, reload, close.
   - Switch to the chlorophyll layer: the gates appear in the legend. Switch to nFLH: the threshold marks the step in the scale, and bloom pixels sit above it.
   - On 14 Feb 2026, sites on the east coast (Dibba, Khor Fakkan) stay Clear: the bloom off Dubai is far by sea, around Musandam.
   - Switch between light and dark: panels, basemap and markers stay readable.
   - Open a bloom date (surface currents are on from the start): particles move over the water only, drift tracks start at the *C. polykrikoides*-like (dashed) and green *Noctiluca*-like (dotted) patches, and a patch pixel's details give its drift, naming the patch's class.
4. Check the overlay position against coastlines (the land pixels against the basemap).
5. Break a copy of `grid.json` (wrong length, wrong `contract_version`) and confirm the message is friendly and the other scenes still work.
6. Re-read the must-have list above before calling a phase done.

# Gulf Bloom Watch: the project

This is the shared overview for the team and for Claude Code. The data contract is in `DATA_CONTRACT.md`.

## The hackathon

- **Event:** Arab Youth Space Hackathon 2026, Challenge 813, organized by the UAE's National Space Academy with Space42. Marine track.
- **Deadline:** 11th of October. Time is short, so a working, explainable demo beats an ambitious unfinished one.
- **What the organizers emphasize:** in the workshop they said to *"use deep learning only where it adds value"*, and that *"a small solution that runs and produces a trustworthy insight is stronger than a complex model that cannot be explained or reproduced."* Feasibility and quality of space-data use are among the judging criteria.

## Team and roles

| Role | Who | Owns |
|---|---|---|
| Interface | Manar | The dashboard, `data/sites.geojson` |
| Data team | _(names)_ | The satellite pipeline, everything in `data/` except sites |

The two sides meet only through the files in `DATA_CONTRACT.md`. The dashboard is built on mock data first, so both sides work in parallel.

## The problem

Harmful algal blooms (HABs) are outbreaks of microscopic algae that kill marine life and disrupt coastal industries. Our target is *Cochlodinium polykrikoides* (also called *Margalefidinium polykrikoides*), a dinoflagellate that kills fish mainly by damaging their gills.

In 2008–09 it caused a massive red tide across the Sea of Oman and the Arabian Gulf. The bloom killed large numbers of fish and forced desalination plants in the region to shut down. Gulf countries rely on desalination for drinking water, so this is a water-security problem as well as an environmental one.

## The idea

A map-based early-warning dashboard that:

1. **Finds dense blooms and names the ones that look like *C. polykrikoides*,** using NASA's PACE satellite (a hyperspectral ocean-color sensor launched in February 2024).
2. **Explains every flag,** showing the pixel's chlorophyll, fluorescence and depth, its cluster's spectral match to each reference, and how sure the naming is.
3. **Shows which watched sites are near a flagged bloom:** desalination intakes, fish farms and beaches.

**Users:** desalination and fish-farm operators, coastal authorities and, later, the public.

## The method

1. **Area and dates.** The analysis dates cover one area, 21.8–27.03°N and 51.2–60.79°E: the UAE's Arabian Gulf coast, the Strait of Hormuz and the Oman coast of the Sea of Oman, where most desalination plants are, from Qatar's east coast to past Ras al Hadd. Clear PACE passes in the bloom season (October–April), 2024–2026, each over the whole area. The held-out test date has its own area, 19–26.5°N and 56–63°E: the Gulf of Oman and Oman's Arabian Sea coast, following the test bloom's documented drift so the result can be compared with NASA's images.
2. **Data.** PACE OCI Level-2 products:

   | Product | Contents | Used for |
   |---|---|---|
   | `PACE_OCI_L2_AOP` | Rrs: hyperspectral reflectance at every wavelength; nflh: fluorescence line height | PCA, k-means, spectral matching; nflh for the density gate |
   | `PACE_OCI_L2_BGC` | chlor_a: chlorophyll concentration | The density gate and the chlorophyll map layer |
   | `PACE_OCI_L2_IOP` | bbp: particle backscatter | Picking the turbid-water reference pixels (the top 5% of backscatter) |

   After the quality flags, each swath is resampled (nearest neighbour, about 2 km search radius) onto one regular 0.01° lat/lon grid (about 1.1 km, roughly PACE's pixel size). Every date then has arrays of the same shape, and a cell is the same spot of sea on every date.
3. **Filtering.** Water shallower than 5 m (GEBCO bathymetry on the same grid) is checked first and is *not assessed*, because the seabed can show through. Its readings are still stored and shown. Elsewhere, PACE quality flags mask clouds, glint, land and low-quality pixels (no data). Water 5–15 m deep is assessed but flagged: the dashboard warns that the seabed may affect the result.
4. **Density gate, two signals.** Below 5 mg/m³ of chlorophyll is no bloom. A pixel is dense enough to try to name a species only with chlorophyll of 10 or more **and** raised fluorescence (nflh of 0.2479 W m⁻² µm⁻¹ sr⁻¹ or more: the level 95% of normal water, chlorophyll under 1, stays under on the calm dates). Living algae glow faintly red; mud and seabed raise the chlorophyll estimate but don't glow. Anything in between is a weak bloom.
5. **PCA and k-means.** Each pixel's spectrum over 430–700 nm is compressed with PCA (124 bands to 5 components keeping 99.2% of the variation), then grouped by two-level k-means (6 coarse groups, then 5 finer clusters inside each: 30 clusters), fitted on the pooled analysis dates.
6. **Naming.** Each cluster's mean spectrum is compared by spectral angle (SAM) with six references: *C. polykrikoides*, green *Noctiluca*, diatoms, clear water, turbid water and shallow seabed (taken from 5–15 m water). It is compared twice:
   - **Shape:** SAM on the reflectance curves over 500–700 nm, which ignores overall brightness. Below about 490 nm the atmospheric correction over-corrects dense blooms, often to below zero, so those bands are left out. The **confidence** is the margin: how clearly the best reference beat the runner-up, measured against how different those two references are, (θ₂ − θ₁) / angle between the two references, clipped to 0–1. Below 0.25 the cluster stays unclassified.
   - **Pigment features:** SAM on the smoothed (Savitzky–Golay, 11 bands, degree 2) second derivative of the curves over 430–700 nm, which flattens broad backgrounds such as a sediment slope and keeps the narrow dips and bumps pigments make.

   A species is named only when both comparisons pick the same reference; otherwise the cluster stays unclassified. A pixel that isn't dense and whose cluster looks most like a water type is non-bloom water; a dense one stays an unclassified bloom.

## Decisions

| Topic | Decision |
|---|---|
| Satellite | **PACE OCI** only, Level-2 AOP, BGC and IOP |
| Detection | Density gate on chlorophyll and fluorescence, then k-means clusters named against six reference spectra by two SAM comparisons (shape, and pigment features from the second derivative) that must agree, and by the SAM margin. No other rule is layered on top |
| Classes | Nine fixed classes, each with a risk tier: Not assessed, No flag, Low, Monitor, Watch or High (`DATA_CONTRACT.md` section 6) |
| Confidence | The SAM margin, 0–1, per cluster; a separation score, not a probability |
| Not doing | Training supervised or deep-learning models, toxicity claims, and species claims beyond "*C. polykrikoides*-like", "*Noctiluca*-like" and "diatom-like" |
| Honest framing | We always say "-like", never "toxic". Every scene shows its role. Mock data is always labeled as mock |
| Tech stack | A static website (no backend, database or API keys) with **MapLibre GL JS**, a free basemap without place labels (the dashboard adds UAE and Oman city names, which can be hidden), NASA GIBS true-color photos, and surface currents from the Open-Meteo Marine API prepared as files for each scene date. Free hosting on GitHub Pages or Netlify |

## Validation plan

| Dates | Role | What it shows |
|---|---|---|
| 9 bloom dates (blooms off the Oman and UAE coasts) | Analysis date (bloom) | The clusters are fitted on these, pooled. Water-type references are taken from them |
| 2 calm dates | Analysis date (calm) | Also pooled into the fit, so it learns normal water |
| 24 Mar 2025 (the Gulf of Oman bloom, imaged by PACE), over its own area | Held-out test date | Not used in the fit. A true-negative check: NASA and Copernicus documented a bloom here, described as likely green *Noctiluca*. The pipeline shouldn't call it *C. polykrikoides*-like: it passes when under 10% of its dense-bloom pixels are, and most are *Noctiluca*-like or unclassified |
| All dates | Plausibility | Do the named blooms fall in the October–April season and in historically bloom-prone waters? Supporting evidence, not proof |

**Results on the real data:**

- **Held-out test passes:** of the 1,220 dense-bloom pixels on 24 March 2025, 72.1% are *Noctiluca*-like, 27.9% unclassified and none *C. polykrikoides*-like.
- **Calm dates stay calm:** 11 October 2024 has 26 dense-bloom pixels (23 *Noctiluca*-like, 3 unclassified); 25 October 2025 has none.
- **Plausible:** 98.6% of the 8,112 *Noctiluca*-like pixels fall between November and March, and 77.8% are on the Gulf of Oman side.
- **No *C. polykrikoides*-like pixel on any date.** None of the dates had a confirmed bloom, so this is the expected result, but detection is untested on real data.
- **A consistency check, not validation:** the *C. polykrikoides* reference mixed with clear water and noise is still named up to 40% clear water, and drops to unclassified at 40% with 2% noise.

## Known limits (we say these openly in the pitch)

- **No confirmed *C. polykrikoides* bloom since PACE launched.** No *C. polykrikoides* bloom in our area has been confirmed by water sampling in PACE's lifetime, so detecting one (a true positive) is untested on real data, and naming in the Gulf isn't validated yet.
- **The test bloom's species isn't confirmed.** NASA Earth Observatory and Copernicus described the March 2025 bloom in the Gulf of Oman as *likely green Noctiluca*, without water sampling. It's a true-negative check only.
- **The reference spectra come from other seas.** The *C. polykrikoides* reference is digitized from a Korean study's published figures, and the *Noctiluca* and diatom references from a northern Arabian Sea study's. They are not Gulf field measurements: digitized and PACE spectra of similar water differ by about 13°.
- **The diatom reference resembles clear water.** It comes from a bloom of moderate density, so a dense diatom bloom would likely show as an unclassified bloom rather than diatom-like.
- **Confidence is a separation score, not a probability.** A confidence of 0.8 means the best reference clearly beat the runner-up, measured against how different those two references are; not "80% chance". There's no confirmed data to calibrate it.
- **Clusters depend on the dates fitted.** A water type that never appears in the analysis dates can be forced into the nearest existing cluster, and the bloom spectra in the fit come mostly from two late-winter 2026 events (14 February and 14 March).
- **Chlorophyll can be off in shallow, muddy or very dense water.** PACE estimates chlorophyll mostly from the ratio of blue to green light. Seabed and sediment change that ratio, so near the shore and in muddy water the estimate comes out too high even without a bloom (NASA's chlorophyll maps often look dense along the coast for this reason). In very dense blooms the ratio stops changing, so the estimate gets less precise. We don't assess water shallower than 5 m. From 5 to 15 m the water is assessed but flagged: sand makes the water look brighter and greener, and seagrass adds a plant-like signal, so either can look like a bloom. Gulf coastal water is often murky enough to hide the seabed even there, so the flag is a caution, not a verdict. Against it we require raised fluorescence as well as high chlorophyll before naming (sand doesn't glow), and the shallow-seabed reference is taken from that 5–15 m zone. Off the UAE's Gulf coast, water under 5 m is typically within 1–3 km of shore, and up to about 25 km out among Abu Dhabi's islands and shoals; the 15 m line is typically 6–7 km out, and 25 km or more among the islands (GEBCO). In the Sea of Oman both lines are within a few km of shore.
- **Right at the shore the data stays rough.** PACE pixels are about 1 km wide, so the first kilometre or two from shore mixes in light from the bright land next to it. The quality flags remove the worst of these pixels, but right at the intake pipes the data stays rough whatever depth cutoff we choose. PACE is the regional early-warning layer: it sees blooms forming offshore and approaching the coast, days before they reach the intakes.
- **Some water can fake a bloom.** Turbid water and shallow seabed can look like blooms; we mitigate this with quality flags, the shallow mask and flag, the fluorescence check and water-type references.
- **Currents are a model estimate.** The surface currents (Météo-France SMOC through Open-Meteo, about 8 km, sampled every 0.25°) are coarse near the coast. A drift track shows where surface water would go in 48 hours; it leaves out wind, the algae's own swimming, and the bloom growing or fading, so it is a direction to watch, not a forecast of arrival.
- **The blue bands are over-corrected in dense blooms.** Below about 490 nm the atmospheric correction pushes dense-bloom pixels too low, often below zero (in 94–100% of dense pixels on the bloom dates; the haze measured points away from dust). So the shape comparison uses 500–700 nm only, and SAM compares shape rather than brightness.
- **Some passes are unusable.** Cloud, or a high viewing angle at the edge of the satellite's swath, leaves parts of some dates without data.
- **Satellites measure color and pigments, not toxins.**

## Roadmap after the hackathon

These are for the pitch, not for this week:

- A field-validation partnership (e.g. with EAD), using water sampling and desalination intake measurements as ground truth.
- Gulf-measured reference spectra to replace the ones from other seas.
- A Gulf-tuned chlorophyll algorithm. Al Shehhi et al. (2019) showed that a fluorescence measure including the 645 nm band fits Gulf water much better (R² from 0.46 to 0.76).
- A nearshore correction for seabed reflectance, to extend reliable coverage to the intake zones. Physics-based shallow-water models (e.g. the semi-analytical models of Lee and colleagues) estimate water depth and seabed brightness together and subtract the seabed's share from each pixel. They need depth data, careful tuning and testing against field measurements: real research work.
- A high-resolution hyperspectral layer (30 m: EnMAP, PRISMA or Satellite 813 itself) for the intake zones PACE can't resolve. "PACE watches the sea, 30 m sensors watch the intakes."
- Daily automated processing.

## Sources

- Richlen et al. (2010), the 2008–09 Gulf red tide: https://www.sciencedirect.com/science/article/abs/pii/S1568988309001048
- NASA Earth Observatory, Gulf of Oman phytoplankton swirls, March 2025: https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/
- Copernicus, image of the day, algal bloom in the Gulf of Oman: https://eu-space.europa.eu/components/earth-observation-copernicus/image-of-day/algal-bloom-gulf-oman
- Kim, Yoo & Son (2016), *C. polykrikoides* reflectance, Korea (to confirm: full citation)
- Dwivedi et al. (2015), *Noctiluca* and diatom reflectance, Northern Arabian Sea (to confirm: full citation)
- Al Shehhi et al. (2019), a fluorescence-based chlorophyll measure for the Gulf (to confirm: full citation)

## Glossary

| Term | Meaning |
|---|---|
| **HAB** | Harmful algal bloom |
| **PACE / OCI** | NASA's Plankton, Aerosol, Cloud, ocean Ecosystem satellite and its Ocean Color Instrument. It's hyperspectral: hundreds of narrow color bands. |
| **Level-2** | Satellite data at the original swath geometry, per pass; we grid it onto a regular map grid |
| **Rrs** | Remote-sensing reflectance: how much sunlight the water reflects at each wavelength (sr⁻¹) |
| **Chlorophyll-a (chlor_a)** | The main algal pigment, in mg/m³; the first signal of our density gate |
| **nflh** | Normalized fluorescence line height: how tall the faint red glow of living algae (near 678 nm) stands above a line between the neighbouring bands, adjusted for sun angle. Sediment, seabed and dissolved material don't glow, so it is more algae-specific than chlorophyll; the second signal of our density gate |
| **GEBCO** | The General Bathymetric Chart of the Oceans: a free global map of water depth. We use it for the shallow-water mask |
| **PCA** | Principal component analysis: compresses each pixel's ~200-band spectrum into a few uncorrelated components that keep most of the variation |
| **k-means** | Groups pixels into a set number of clusters by similarity, without labels |
| **Spectral angle (SAM)** | How similar two spectra are in shape. A smaller angle means more similar |
| **Second derivative** | How sharply a curve bends at each wavelength. Broad, smooth backgrounds barely bend and almost vanish; narrow pigment dips and bumps bend sharply and stand out. Our second comparison uses it |
| **Savitzky–Golay filter** | A smoothing filter that fits a small curve through a few neighbouring points at a time. We smooth before taking the derivative, because derivatives magnify noise |
| **Margin** | How clearly a cluster's best reference beat its second-best (by shape), measured against how different those two references are: our confidence |
| **Risk tier** | The level of concern a class means for operators, lowest first: not assessed (land, shallow water, no data), no flag, low, monitor, watch, high |
| **GIBS** | NASA's free service of daily satellite photo tiles |
| **Mock data** | Invented files in the exact contract format, used to build the interface before real data exists |

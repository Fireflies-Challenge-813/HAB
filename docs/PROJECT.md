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

1. **Flags water that looks like a *C. polykrikoides* bloom,** using NASA's PACE satellite (a hyperspectral ocean-color sensor launched in February 2024).
2. **Explains every flag,** showing which measurements passed or failed and why.
3. **Shows which watched sites are near a flagged bloom:** desalination intakes, fish farms and beaches.

**Users:** desalination and fish-farm operators, coastal authorities and, later, the public.

## Decisions we've finalized

| Topic | Decision |
|---|---|
| Detection method | A published rule, Ghanea, Moradi and Kabiri (2016), *Advances in Space Research* 58(7). A pixel is *C. polykrikoides*-like when **Rrs(667)/Rrs(443) > 1** and **nFLH > 0.04 mW cm⁻² µm⁻¹ sr⁻¹**. It was derived on Gulf data, it's explainable, and it's fast to build. |
| Satellite | **PACE OCI** is the main input. **MODIS** is used once, on the 2008 bloom, to check our code reproduces the paper. **MERIS is dropped.** |
| Not doing this round | Self-supervised clustering (the SIT-FUSE approach from NASA JPL was inspiration only), training ML models, toxicity claims, and species claims beyond "*C. polykrikoides*-like". |
| Supporting evidence (optional) | The spectral angle between each PACE pixel and a *C. polykrikoides* reference spectrum from Korean field studies. It's shown as supporting evidence and **never changes a pixel's class**. |
| Validation plan | Three tests, listed below. |
| Honest framing | We always say "*C. polykrikoides*-like", never "toxic". Every scene shows its evidence level. Mock data is always labeled as mock. |
| Tech stack | A static website (no backend, database or API keys) with **MapLibre GL JS** for the map, a free basemap without place labels, and NASA GIBS true-color photos. Free hosting on GitHub Pages or Netlify. |

## Validation plan

| Test | Scene | What it shows |
|---|---|---|
| True positive | Korean south coast, August 2026 (PACE) | Does the pipeline flag an officially reported bloom? Korea's fisheries institute (NIFS) issued a "Caution" red-tide alert for *M. polykrikoides*. |
| Probable negative | Gulf of Oman, 8 March 2025 (PACE) | Does it stay quiet on swirls NASA said *likely* include *Noctiluca*? (Not confirmed by sampling.) |
| Implementation check | Gulf, October–December 2008 (MODIS) | Does our code reproduce the published rule on the documented 2008 bloom? This tests our code, not the rule. |
| Monitoring | Recent clear Gulf scenes (PACE) | Shown as unvalidated. |

## Known limits (we say these openly in the pitch)

- **No confirmed *C. polykrikoides* bloom has occurred in the Gulf since PACE launched,** so detection in the Gulf with PACE isn't validated yet. Korea is our stand-in true-positive test.
- **The 2008 check only reproduces the paper** on the event the paper was built from.
- **The March 2025 Gulf of Oman bloom isn't confirmed.** NASA's *Noctiluca* identification was "likely", without water sampling.
- **PACE's bands don't match MODIS exactly.** Standard PACE Rrs stops at about 719 nm, and version-3 files leave out 590–610 nm. The fluorescence baseline therefore uses about 717 nm instead of MODIS's 748 nm, so the 0.04 threshold may not carry over exactly.
- **Some water can fake the signal.** Dust, muddy water and shallow seabed can raise the red/blue ratio. We mitigate this with masks and by requiring both conditions.
- **Satellites measure color and pigments, not toxins.**

## Roadmap after the hackathon

These are for the pitch, not for this week:

- Partner with desalination plants to use their intake water-quality measurements as ground truth.
- Validate bloom-type discrimination using PACE's full spectrum.
- Add daily automated processing.

## Sources

- Ghanea, Moradi and Kabiri (2016): https://www.sciencedirect.com/science/article/abs/pii/S0273117716302848
- Richlen et al. (2010), the 2008–09 Gulf red tide: https://www.sciencedirect.com/science/article/abs/pii/S1568988309001048
- NASA Earth Observatory, Gulf of Oman, March 2025: https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/
- Korea red tide alert, August 2026: https://www.techtimes.com/articles/323801/20260810/south-koreas-gill-clogging-red-tide-alert-threatens-fish-farms-already-battered-heat.htm
- PACE Rrs wavelength limit (NASA Earthdata forum): https://forum.earthdata.nasa.gov/viewtopic.php?t=7129

## Glossary

| Term | Meaning |
|---|---|
| **HAB** | Harmful algal bloom |
| **PACE / OCI** | NASA's Plankton, Aerosol, Cloud, ocean Ecosystem satellite and its Ocean Color Instrument. It's hyperspectral: hundreds of narrow color bands. |
| **MODIS** | An older NASA sensor (on the Aqua satellite since 2002) with a handful of ocean-color bands |
| **Rrs** | Remote-sensing reflectance: how much sunlight the water reflects at each wavelength (sr⁻¹) |
| **nFLH** | Normalized fluorescence line height: how strongly algae glow red, a proxy for active chlorophyll |
| **Spectral angle (SAM)** | How similar two spectra are in shape. A smaller angle means more similar. |
| **GIBS** | NASA's free service of daily satellite photo tiles |
| **Mock data** | Invented files in the exact contract format, used to build the interface before real data exists |

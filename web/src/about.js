// "About and limits": what the dashboard shows, how a pixel is classified,
// what each evidence level means, and the known limits (docs/PROJECT.md).
// Thresholds come from manifest.rule; sources from the manifest and references.json.

import { esc, richText, icon, fmtChl, fmtNflh, fmtMargin, prettyUnits, ROLES } from './format.js';
import { ALERT_KM, NEAR_KM } from './sites.js';

// Depth and band limits come from the manifest. The distances are GEBCO measurements, taken for 5 m and 15 m.
const limits = (rule) => {
  const lo = rule.shallow_max_m ?? '?';
  const hi = rule.shallow_flag_max_m ?? '?';
  const [samLo, samHi] = rule.sam_range_nm ?? ['?', '?'];
  return [
    ['No confirmed C. polykrikoides bloom since PACE launched.', 'No C. polykrikoides bloom in our area has been confirmed by water sampling in PACE’s lifetime, so detecting one (a true positive) is untested on real data, and naming in the Gulf isn’t validated yet.'],
    ['The test bloom’s species isn’t confirmed.', 'NASA Earth Observatory and Copernicus described the March 2025 bloom in the Gulf of Oman as likely green Noctiluca, without water sampling. It is a true-negative check only.'],
    ['The reference spectra come from other seas.', 'The C. polykrikoides reference is digitized from a Korean study’s published figures, and the Noctiluca and diatom references from a northern Arabian Sea study’s. They are not Gulf field measurements: digitized and PACE spectra of similar water differ by about 13°.'],
    ['The diatom reference resembles clear water.', 'It comes from a bloom of moderate density, so a dense diatom bloom would likely show as an unclassified bloom rather than diatom-like.'],
    ['Confidence is a separation score, not a probability.', 'A confidence of 0.8 means the best reference clearly beat the runner-up, measured against how different those two references are; not an 80% chance. There is no confirmed data to calibrate it.'],
    ['Clusters depend on the dates fitted.', 'A water type that never appears in the analysis dates can be forced into the nearest existing cluster, and the bloom spectra in the fit come mostly from two late-winter 2026 events (14 February and 14 March).'],
    ['Chlorophyll can be off in shallow, muddy or very dense water.', `PACE estimates chlorophyll mostly from the ratio of blue to green light. Seabed and sediment change that ratio, so near the shore and in muddy water the estimate comes out too high even without a bloom; in very dense blooms the ratio stops changing, so the estimate gets less precise. Water shallower than ${lo} m isn’t assessed. From ${lo} to ${hi} m it is assessed but flagged: sand and seagrass on the bottom can still show through and look like a bloom. Gulf coastal water is often murky enough to hide the seabed, so the flag is a caution, not a verdict. There we rely on the fluorescence check (sand doesn’t glow) and a shallow-seabed reference taken from that zone. Off the UAE’s Gulf coast, water under ${lo} m is typically within 1–3 km of shore, and up to about 25 km out among Abu Dhabi’s islands and shoals; the ${hi} m line is typically 6–7 km out, and 25 km or more among the islands. In the Sea of Oman both lines are within a few km of shore (GEBCO).`],
    ['Right at the shore the data stays rough.', 'PACE pixels are about 1 km wide, so the first kilometre or two from shore mixes in light from the bright land next to it. The quality flags remove the worst of these pixels, but right at the intake pipes the data stays rough whatever depth cutoff is chosen. PACE is the regional early-warning layer: it sees blooms forming offshore and approaching the coast, before they reach the intakes.'],
    ['Currents are a model estimate.', 'The surface currents come from the Météo-France SMOC model (through Open-Meteo) at about 8 km, sampled every 0.25°, so they are coarse near the coast and among the islands. The animation shows the net flow over the day; tides, which reverse every few hours, are averaged out. A drift track shows where surface water would go in 48 hours from about the satellite’s pass. It leaves out wind, the algae’s own daily swimming up and down, and the bloom growing or fading, so it is a direction to watch, not a forecast of arrival.'],
    ['Some water can fake a bloom.', 'Turbid water and shallow seabed can look like blooms. Quality flags, the shallow mask and flag, the fluorescence check and the water-type references reduce this.'],
    ['The blue bands are over-corrected in dense blooms.', `In dense blooms the atmospheric correction pushes the bands below about 490 nm too low, often below zero (in 94–100% of dense pixels on the bloom dates; the haze measured points away from dust). So the shape comparison uses ${samLo}–${samHi} nm only, and compares shape rather than brightness.`],
    ['Some passes are unusable.', 'Cloud, or a high viewing angle at the edge of the satellite’s swath, leaves parts of some dates without data.'],
    ['Satellites measure color and pigments, not toxins.', 'A flag means the water looks like a C. polykrikoides bloom, not that it is harmful.'],
  ];
};

const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

export function renderAbout({ manifest, references, scenes, fit }) {
  const { rule } = manifest;
  const units = esc(prettyUnits(rule.chl_units ?? 'mg m^-3'));
  const bands = [...rule.confidence_bands].sort((a, b) => a.min - b.min);
  const mock = scenes.some((s) => s.status === 'mock');
  const refs = references ? [...references.values()] : [];
  const range = (r) => (Array.isArray(r) ? `${esc(r[0])}–${esc(r[1])} nm` : '');
  const pca = fit?.pca_components ? ` (${esc(fit.pca_components)} components)` : '';
  const kmeans = fit?.k_coarse && fit?.k_fine ? ` (${esc(fit.k_coarse)} coarse groups, then ${esc(fit.k_fine)} clusters)` : '';

  return `
    <div class="about-head">
      <h2 id="about-title">About and limits</h2>
      <button type="button" class="icon-btn" data-action="close-about" title="Close">${icon('close')}<span class="visually-hidden">Close</span></button>
    </div>
    <div class="about-body">
      ${mock ? `<p class="note">${icon('warning')}<span><strong>This build shows mock data.</strong> Scenes labeled Mock are generated placeholders in the real file format, not satellite observations.</span></p>` : ''}

      <section>
        <h3>What this shows</h3>
        <p>${richText('Gulf Bloom Watch flags dense algal blooms in the Arabian Gulf and Sea of Oman from NASA’s PACE satellite and names the ones whose color looks like C. polykrikoides, the dinoflagellate behind the 2008–09 red tide that killed fish and shut desalination plants. Every flag can be clicked to see why it was raised, and watched sites (desalination intakes, fish farms, beaches) show how close the nearest flag is.')}</p>
      </section>

      <section>
        <h3>How a pixel is classified</h3>
        <ol class="about-steps">
          <li><strong>Usable water only.</strong> Water shallower than ${esc(rule.shallow_max_m ?? '?')} m (GEBCO depth) is checked first and is <em>not assessed</em>: the seabed can show through and raise the readings, so no species is named there. Elsewhere, PACE quality flags remove cloud, sun glint and land (no data). It is hatched on the map; where PACE’s reading is kept, the chlorophyll layer still shows it. Water from ${esc(rule.shallow_max_m ?? '?')} to ${esc(rule.shallow_flag_max_m ?? '?')} m deep is assessed but <em>flagged</em>: its pixel details warn that the seabed may affect the result.</li>
          <li><strong>Density gate, two signals.</strong> Chlorophyll-a below <span class="mono">${fmtChl(rule.chl_weak_min)}</span> ${units} is non-bloom water. A pixel is <em>dense</em> only when chlorophyll is <span class="mono">${fmtChl(rule.chl_dense_min)}</span> or more <em>and</em> fluorescence (nflh, the faint red glow of living algae) is at least <span class="mono">${fmtNflh(rule.nflh_dense_min)}</span> ${esc(prettyUnits(rule.nflh_units ?? ''))}, the level 95% of normal water stays under on the calm dates. Anything in between is a weak bloom, too thin to name.</li>
          <li><strong>Clusters.</strong> Each pixel’s spectrum (over a hundred colors) is compressed with PCA${pca} and grouped by two-level k-means${kmeans}, fitted on the analysis dates.</li>
          <li><strong>Naming.</strong> Each cluster’s mean spectrum is compared by spectral angle with six references: three blooms (${richText('C. polykrikoides, green Noctiluca, diatoms')}) and three water types (clear, turbid, and shallow seabed taken from ${esc(rule.shallow_max_m ?? '?')}–${esc(rule.shallow_flag_max_m ?? '?')} m water). It is compared twice: by the <em>shape</em> of the curves${rule.sam_range_nm ? ` over ${range(rule.sam_range_nm)}` : ''}, and by their <em>pigment features</em>, the ${esc(rule.deriv_filter ?? 'smoothed')} second derivative${rule.deriv_range_nm ? ` over ${range(rule.deriv_range_nm)}` : ''}, which flattens broad backgrounds such as a sediment slope and keeps the narrow dips and bumps pigments make. A species is named only when both pick the same reference. A pixel that isn’t dense and whose cluster looks most like a water type is non-bloom water; a dense one is an unclassified bloom.</li>
          <li><strong>Confidence.</strong> The margin between the best and second-best shape match, measured against how different those two references are: <span class="mono">(2nd − best) ÷ angle between the two references</span>, kept between 0 and 1. Below <span class="mono">${fmtMargin(rule.margin_min)}</span> the cluster stays unclassified. Bands: ${bands.map((b) => `${esc(b.label)} <span class="mono">≥ ${fmtMargin(b.min)}</span>`).join(', ')}. A separation score, not a probability.</li>
          <li><strong>Flags on top of the class.</strong> A clicked pixel can also carry flags, each with a note: <em>shallow ${esc(rule.shallow_max_m ?? '?')}–${esc(rule.shallow_flag_max_m ?? '?')} m</em> (the seabed may affect the result) and <em>turbid water</em> (non-bloom water that best matches turbid water while its chlorophyll reads at bloom levels, likely inflated by sediment). Flags never change the class.</li>
          <li><strong>Surface currents</strong> (optional layer). Particles follow the day’s net surface current. From each ${richText('C. polykrikoides')}-like patch, a dashed track follows the hourly currents (tides included) for 48 hours from 09:00 UTC, about the satellite’s pass, with marks at 24 and 48 hours. The site statuses don’t use it.</li>
        </ol>
      </section>

      <section>
        <h3>Evidence levels</h3>
        <dl class="about-roles">
          ${Object.entries(ROLES)
            .map(([key, r]) => `<div><dt>${icon(r.icon)}${esc(r.label)}</dt><dd>${richText(ABOUT_ROLE[key] ?? r.blurb)}</dd></div>`)
            .join('')}
        </dl>
      </section>

      <section>
        <h3>Watched sites</h3>
        <p><strong>Alert</strong>: a ${richText('C. polykrikoides')}-like cell within ${ALERT_KM} km by sea. <strong>Nearby</strong>: within ${NEAR_KM} km by sea. <strong>Unknown</strong>: no usable water within ${NEAR_KM} km (cloud, or water too shallow to assess), or the date covers another area. <strong>Clear</strong>: otherwise. Distances are by sea, the shortest way through the water around land, so a bloom on the far side of a peninsula such as Musandam doesn’t count as near. Statuses are worked out in your browser from the day’s grid.</p>
        <p>The sites are real seawater desalination plants, fish farms (sea cages and seawater hatcheries or ponds) and public beaches on the UAE and Oman coasts. Their locations come from OpenStreetMap, the Environment Agency – Abu Dhabi’s aquaculture open data and operators’ announcements; each site names its source, and the few whose exact spot isn’t published are marked approximate. The buttons under the map’s zoom control show or hide each type.</p>
      </section>

      ${mock ? '' : RESULTS}

      <section>
        <h3>Known limits</h3>
        <ul class="about-limits">
          ${limits(rule).map(([head, body]) => `<li><strong>${richText(head)}</strong> ${richText(body)}</li>`).join('')}
        </ul>
      </section>

      <section>
        <h3>Next steps</h3>
        <ul class="about-limits">
          <li><strong>Field validation.</strong> A partnership (for example with EAD) for water sampling and desalination intake measurements as ground truth.</li>
          <li><strong>Gulf-measured references.</strong> Reference spectra measured in the Gulf, to replace the ones from other seas.</li>
          <li><strong>A Gulf-tuned chlorophyll algorithm.</strong> Al Shehhi et al. (2019) found a fluorescence measure that includes the 645 nm band fits Gulf water much better (R² from 0.46 to 0.76).</li>
          <li><strong>Nearshore correction for seabed reflectance.</strong> Semi-analytical shallow-water models (Lee and colleagues) estimate water depth and seabed brightness together and subtract the seabed’s share from each pixel, to extend reliable coverage to the intake zones. They need depth data, careful tuning and field measurements.</li>
          <li><strong>A 30 m layer for the intakes.</strong> High-resolution hyperspectral imagery (EnMAP, PRISMA or Satellite 813) for the intake zones PACE can’t resolve: PACE watches the sea, 30 m sensors watch the intakes.</li>
          <li><strong>Daily processing,</strong> so the map updates with every PACE pass.</li>
        </ul>
      </section>

      <section>
        <h3>Sources</h3>
        <ul class="about-sources">
          <li>${link('https://www.sciencedirect.com/science/article/abs/pii/S1568988309001048', 'Richlen et al. (2010)')}: the 2008–09 Gulf red tide.</li>
          <li>${link('https://science.nasa.gov/earth/earth-observatory/a-swirl-of-a-day-for-phytoplankton-154086/', 'NASA Earth Observatory, March 2025')} and ${link('https://eu-space.europa.eu/components/earth-observation-copernicus/image-of-day/algal-bloom-gulf-oman', 'Copernicus image of the day')}: the Gulf of Oman bloom used as the held-out test.</li>
          ${refs.map((r) => `<li>Reference spectrum, ${richText(r.label.replace(/\s*\(PLACEHOLDER\)\s*/i, ''))}: ${r.source_url ? link(r.source_url, r.source) : esc(r.source)}</li>`).join('')}
          <li>Satellite data: NASA PACE OCI Level-2 (AOP, BGC, IOP). True-color photos: ${link('https://earthdata.nasa.gov/gibs', 'NASA GIBS')} (VIIRS NOAA-20). Water depth: ${link('https://www.gebco.net', 'GEBCO')} grid (GEBCO Compilation Group). Basemap: ${link('https://openfreemap.org', 'OpenFreeMap')}, © OpenMapTiles, data from ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap')}.</li>
          <li>Surface currents: ${link('https://open-meteo.com/en/docs/marine-weather-api', 'Open-Meteo Marine API')} (CC BY 4.0), from the Météo-France SMOC model of ${link('https://marine.copernicus.eu', 'Copernicus Marine')}; prepared once for each scene date.</li>
          <li>Site locations: ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors')}, ${link('https://arcgis.sdi.abudhabi.ae/agspublish/rest/services/OpenData/ADSDI_OpenData/MapServer/157', 'Environment Agency – Abu Dhabi, Aquaculture Farms')} and press reports; each site’s details link its own source.</li>
        </ul>
      </section>

      <p class="panel-note">Built for the Arab Youth Space Hackathon 2026, Challenge 813. Contract version ${esc(manifest.contract_version)}.</p>
    </div>`;
}

// Longer wording for the evidence levels than the scene panel's one-liners.
const ABOUT_ROLE = {
  analysis_bloom:
    'Bloom dates whose pixels were pooled to fit the clusters. Their flags show what the method finds on data it has seen; they are not an independent test.',
  analysis_calm:
    'Calm-water dates pooled into the same fit, so the clusters also learn what normal water looks like.',
  held_out_test:
    'Dates kept out of the fit on purpose. Their pixels are assigned to the existing clusters and named by the same rules, so the result is an honest test on unseen data. Our test date, 24 March 2025, is a PACE image of the Gulf of Oman bloom that NASA and Copernicus described as likely green Noctiluca, unconfirmed: the method should not call it C. polykrikoides-like. Its own area, from the Gulf of Oman down Oman’s Arabian Sea coast, follows the bloom’s documented drift.',
};

// The data team's results on the real dates (their summary of the run). Shown with real data only.
const RESULTS = `
      <section>
        <h3>What the data shows</h3>
        <ul class="about-limits">
          <li><strong>Held-out test passes.</strong> On 24 March 2025, of the 1,220 dense-bloom pixels, 72.1% are ${richText('Noctiluca')}-like, 27.9% unclassified and none ${richText('C. polykrikoides')}-like, on a bloom NASA and Copernicus described as likely green ${richText('Noctiluca')}. The false-alarm check (under 10% ${richText('C. polykrikoides')}-like, most ${richText('Noctiluca')}-like or unclassified) passes.</li>
          <li><strong>Calm dates stay calm.</strong> 11 October 2024 has 26 dense-bloom pixels (23 ${richText('Noctiluca')}-like, 3 unclassified); 25 October 2025 has none.</li>
          <li><strong>Plausible in time and place.</strong> 98.6% of the 8,112 ${richText('Noctiluca')}-like pixels fall between November and March, and 77.8% are on the Gulf of Oman side.</li>
          <li><strong>No ${richText('C. polykrikoides')}-like pixel on any date.</strong> None of these dates had a confirmed ${richText('C. polykrikoides')} bloom, so this is the expected result, but it means detection is untested on real data.</li>
          <li><strong>A consistency check, not validation.</strong> The ${richText('C. polykrikoides')} reference mixed with clear water and noise is still named up to 40% clear water, and drops to unclassified at 40% with 2% noise. The same reference builds and detects, so this only shows the method is consistent.</li>
        </ul>
      </section>`;

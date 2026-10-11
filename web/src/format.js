// Display helpers: escaping, labels, icons and number formats.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const SPECIES = /\b(?:C\.|M\.|Cochlodinium|Margalefidinium)\s+polykrikoides\b|\bNoctiluca\b/g;

/** Escapes text and italicizes species names. */
export function richText(text) {
  return esc(text).replace(SPECIES, (m) => `<em>${m.replace(' ', '&nbsp;')}</em>`);
}

// Contract decimals (DATA_CONTRACT.md).
export const fmtChl = (v) => (v == null ? 'n/a' : v.toFixed(2));
export const fmtNflh = (v) => (v == null ? 'n/a' : v.toFixed(4));
export const fmtDepth = (v) => (v == null ? 'n/a' : `${Math.round(v)} m`);
export const fmtAngle = (v) => (v == null ? 'n/a' : v.toFixed(2));
export const fmtMargin = (v) => (v == null ? 'n/a' : v.toFixed(2));

export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

export function fmtDate(iso, opts = {}) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
    ...opts,
  });
}

export function fmtLatLon(lat, lon, digits = 3) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

export function prettyUnits(units = '') {
  return units.replace(/\^-1/g, '⁻¹').replace(/\^-2/g, '⁻²').replace(/\^-3/g, '⁻³').replace(/\bum\b/g, 'µm');
}

export const SENSORS = {
  pace: 'PACE OCI',
};

const ICONS = {
  bloomDate: '<circle cx="8" cy="8" r="5" fill="currentColor"/>',
  calmDate: '<circle cx="8" cy="8" r="4.6"/>',
  testDate: '<path d="M8 2.2 13.8 8 8 13.8 2.2 8z" fill="currentColor"/>',
  eye: '<path d="M1 8s2.6-4.6 7-4.6S15 8 15 8s-2.6 4.6-7 4.6S1 8 1 8z"/><circle cx="8" cy="8" r="2"/>',
  question: '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.5v.3"/>',
  warning: '<path d="M8 1.8 15 14H1z"/><path d="M8 6v4M8 11.6v.4"/>',
  satellite:
    '<rect x="6" y="6" width="4" height="4" transform="rotate(45 8 8)"/><path d="m3.5 3.5 2 2M10.5 10.5l2 2M1.5 5.5l4-4M10.5 14.5l4-4"/><path d="M12 1.5a2.5 2.5 0 0 1 2.5 2.5"/>',
  external: '<path d="M6.5 3H3v10h10V9.5M9 2h5v5M14 2 7.5 8.5"/>',
  layers: '<path d="m8 2 6.5 3.4L8 8.8 1.5 5.4z"/><path d="m1.5 8.3 6.5 3.4 6.5-3.4M1.5 11.2 8 14.6l6.5-3.4"/>',
  tierHigh: '<path d="M8 1.8 15 14H1z" fill="currentColor" stroke="none"/><path d="M8 6.2v3.6M8 11.5v.3" stroke="#fff" stroke-width="1.7"/>',
  tierWatch: '<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="currentColor" stroke="none"/>',
  notAssessed: '<circle cx="8" cy="8" r="5.4"/><path d="M4.2 11.8 11.8 4.2"/>',
  tierLow: '<circle cx="8" cy="8" r="5.6" fill="currentColor" stroke="none"/>',
  dash: '<path d="M3.5 8h9"/>',
  check: '<path d="m3 8.5 3.2 3.2L13 4.8"/>',
  cross: '<path d="m4 4 8 8M12 4l-8 8"/>',
  skip: '<circle cx="8" cy="8" r="1.2" fill="currentColor"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  compare: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="M8 2.8h5.2a1 1 0 0 1 1 1v8.4a1 1 0 0 1-1 1H8z" fill="currentColor" stroke="none" opacity=".35"/><path d="M8 1.2v13.6"/>',
  swap: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
  chevronLeft: '<path d="M10 3 5 8l5 5"/>',
  chevronRight: '<path d="m6 3 5 5-5 5"/>',
  pin: '<path d="M8 15s5-4.6 5-8.5A5 5 0 0 0 3 6.5C3 10.4 8 15 8 15z"/><circle cx="8" cy="6.5" r="1.8"/>',
  drop: '<path d="M8 1.8s4.6 5 4.6 8.2A4.6 4.6 0 0 1 3.4 10C3.4 6.8 8 1.8 8 1.8z"/>',
  fish: '<path d="M1.8 8c2.2-3 6.6-4.2 10 0-3.4 4.2-7.8 3-10 0z"/><path d="m11.8 8 2.6-2.4v4.8z"/><circle cx="5.3" cy="7.4" r=".5" fill="currentColor"/>',
  umbrella: '<path d="M2 8a6 6 0 0 1 12 0z"/><path d="M8 8v5a1.5 1.5 0 0 1-3 0"/>',
  anchor: '<circle cx="8" cy="3.6" r="1.6"/><path d="M8 5.2V14M3 9a5 5 0 0 0 10 0M5.6 7.4h4.8"/>',
  pointer: '<path d="M3.2 2.4 12.6 6.8 8.6 8.1 7.2 12.2z"/><path d="m8.7 8.2 4.3 4.3"/>',
  arrow: '<path d="M8 13.5V2.8M3.8 6.8 8 2.6l4.2 4.2"/>',
  label: '<path d="M3.2 13 7.2 3h1.6l4 10M4.8 9.4h6.4"/>',
  ruler: '<path d="M1.8 11.3 11.3 1.8l2.9 2.9-9.5 9.5z"/><path d="m4.6 8.5 1.4 1.4M6.8 6.3l1.4 1.4M9 4.1l1.4 1.4"/>',
  area: '<path d="M2.5 5 9 2.2l4.5 5.6-3.7 5.9-6.6-2.4z" stroke-dasharray="2 1.6"/><circle cx="2.5" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="2.2" r="1" fill="currentColor"/><circle cx="13.5" cy="7.8" r="1" fill="currentColor"/><circle cx="9.8" cy="13.7" r="1" fill="currentColor"/><circle cx="3.2" cy="11.3" r="1" fill="currentColor"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4.3M8 4.7v.3"/>',
  bell: '<path d="M4 11V7.4a4 4 0 0 1 8 0V11l1.2 1.4H2.8z"/><path d="M6.6 14h2.8"/>',
};

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ICONS.question}</svg>`;
}

// Evidence levels (the scene `role`), in plain language.
export const ROLES = {
  analysis_bloom: {
    label: 'Analysis date (bloom)',
    short: 'Analysis · bloom',
    icon: 'bloomDate',
    blurb: 'A bloom date pooled into the cluster fit. Its flags show what the method finds; they are not an independent test.',
  },
  analysis_calm: {
    label: 'Analysis date (calm, non-bloom)',
    short: 'Analysis · calm',
    icon: 'calmDate',
    blurb: 'A calm-water date pooled into the cluster fit, so the method learns what normal water looks like.',
  },
  held_out_test: {
    label: 'Held-out test date',
    short: 'Held-out test',
    icon: 'testDate',
    blurb: 'Not used in the cluster fit. Test date: NASA-documented bloom, likely Noctiluca (unconfirmed). The method should not call it C. polykrikoides-like.',
  },
};

export function roleInfo(role) {
  return (
    ROLES[role] ?? {
      label: 'Unknown evidence level',
      short: 'Unknown role',
      icon: 'question',
      blurb: `The manifest gives this scene the role "${role}", which this dashboard doesn't recognize.`,
    }
  );
}

export function roleBadge(role, cls = '') {
  const info = roleInfo(role);
  return `<span class="badge badge-role role-${esc(role)} ${cls}">${icon(info.icon)}<span>${esc(info.label)}</span></span>`;
}

export function statusBadge(status) {
  return status === 'mock'
    ? `<span class="badge badge-mock">${icon('warning')}<span>Mock</span></span>`
    : `<span class="badge badge-real">${icon('satellite')}<span>Pipeline output</span></span>`;
}

export const SITE_TYPES = {
  desalination: { label: 'Desalination plant', plural: 'Desalination plants', icon: 'drop' },
  aquaculture: { label: 'Fish farm', plural: 'Fish farms', icon: 'fish' },
  beach: { label: 'Beach', plural: 'Beaches', icon: 'umbrella' },
  port: { label: 'Port', plural: 'Ports', icon: 'anchor' },
  other: { label: 'Site', plural: 'Other sites', icon: 'pin' },
};

// City and town names for the UAE and Oman coasts, drawn over the map (the basemap
// has no labels). Positions are OpenStreetMap place points (place=city/town, read
// through Overpass), rounded to 4 decimals.
//
// rank: 1 shows from zoom 5.2 (the whole area on a laptop; a phone zooms in first),
// 2 from zoom 7.5, 3 from zoom 9 (where the towns are close together).
// side: where the name sits beside its dot, chosen so names don't run into each other.

export const PLACE_ZOOMS = { 1: 5.2, 2: 7.5, 3: 9 };

export const PLACES = [
  // UAE, Arabian Gulf coast
  { name: 'Abu Dhabi', lon: 54.3774, lat: 24.4538, rank: 1, side: 'right' },
  { name: 'Dubai', lon: 55.2924, lat: 25.2647, rank: 1, side: 'bottom' },
  { name: 'Ras Al Khaimah', lon: 55.9382, lat: 25.7738, rank: 1, side: 'right' },
  { name: 'Sharjah', lon: 55.4211, lat: 25.3461, rank: 2, side: 'right' },
  { name: 'Umm Al Quwain', lon: 55.5475, lat: 25.552, rank: 2, side: 'right' },
  { name: 'Ajman', lon: 55.4451, lat: 25.3937, rank: 3, side: 'right' },
  { name: 'Al Ain', lon: 55.7452, lat: 24.2249, rank: 2, side: 'right' },
  { name: 'Ruwais', lon: 52.7208, lat: 24.0858, rank: 2, side: 'bottom' },
  { name: 'Mirfa', lon: 53.4871, lat: 24.0962, rank: 2, side: 'bottom' },
  // UAE, Sea of Oman coast
  { name: 'Fujairah', lon: 56.3355, lat: 25.1245, rank: 1, side: 'right' },
  { name: 'Khor Fakkan', lon: 56.3478, lat: 25.3492, rank: 2, side: 'right' },
  { name: 'Kalba', lon: 56.3542, lat: 25.0513, rank: 3, side: 'right' },
  { name: 'Dibba', lon: 56.2689, lat: 25.6177, rank: 2, side: 'left' },
  // Oman
  { name: 'Khasab', lon: 56.247, lat: 26.1841, rank: 1, side: 'bottom' },
  { name: 'Shinas', lon: 56.4598, lat: 24.7442, rank: 2, side: 'left' },
  { name: 'Sohar', lon: 56.7298, lat: 24.342, rank: 1, side: 'left' },
  { name: 'Saham', lon: 56.8758, lat: 24.1425, rank: 2, side: 'left' },
  { name: 'As Suwaiq', lon: 57.4238, lat: 23.8244, rank: 2, side: 'left' },
  { name: 'Barka', lon: 57.8821, lat: 23.6666, rank: 2, side: 'left' },
  { name: 'Seeb', lon: 58.2058, lat: 23.6548, rank: 2, side: 'left' },
  { name: 'Muscat', lon: 58.5938, lat: 23.6124, rank: 1, side: 'bottom' },
  { name: 'Quriyat', lon: 58.9187, lat: 23.265, rank: 2, side: 'left' },
  { name: 'Sur', lon: 59.5296, lat: 22.5693, rank: 1, side: 'left' },
  // Oman, Arabian Sea coast (the held-out test date's area; read through Nominatim)
  { name: 'Ras Al Hadd', lon: 59.7944, lat: 22.5094, rank: 2, side: 'right' },
  { name: 'Al Ashkharah', lon: 59.57, lat: 21.85, rank: 2, side: 'left' },
  { name: 'Masirah', lon: 58.873, lat: 20.66, rank: 2, side: 'right' },
  { name: 'Duqm', lon: 57.634, lat: 19.623, rank: 1, side: 'left' },
];

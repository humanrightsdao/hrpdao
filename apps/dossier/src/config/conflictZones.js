// src/config/conflictZones.js
//
// A CURATED, hand-maintained list of current conflict hot spots shown on the
// violations map as clusters of H3 hexagons ("danger zones").
//
// This is deliberately NOT computed from user posts: it describes where
// armed conflicts / acute tensions are right now, independent of any court
// decision or investigation.
//
// HOW TO EDIT
//   • Add / remove / change an entry below — nothing else needs touching.
//   • `seeds` are [lat, lng, k?] points. Each seed becomes the H3 cell that
//     contains it, plus `k` rings of neighbouring cells around it (k = 0 →
//     just that one hexagon, 1 → 7 hexagons, 2 → 19 …). Use several seeds
//     to shape a long front line.
//   • `resolution` is the hexagon size for the whole zone (approximate
//     width from edge to edge, ~ 2 × edge length):
//         3 ≈ 140 km   – large wars, front lines
//         4 ≈  52 km   – regions
//         5 ≈  20 km   – small areas (a city, a strip)
//   • `status`: "war" = active armed conflict, "tension" = high tension /
//     fragile ceasefire / risk of escalation.
//   • `reviewed` = the date you last checked that the entry is still valid.
//     It is shown in the zone's popup so readers can see how fresh it is.
//   • Zone names are translated through the i18n key `conflict_zone_<id>`;
//     where a language has no such key, `name` (English) is used.
//
// The list below is a STARTING POINT assembled from public sources
// (e.g. Wikipedia's "List of ongoing armed conflicts", news reports of
// Oct 2026). Seeds are approximate — review it before relying on it.

export const CONFLICT_STATUS = {
  war: {
    key: "war",
    rank: 2,
    color: "#dc2626",
    fillOpacity: 0.38,
    labelKey: "conflict_status_war",
    label: "Active conflict",
  },
  tension: {
    key: "tension",
    rank: 1,
    color: "#f59e0b",
    fillOpacity: 0.3,
    labelKey: "conflict_status_tension",
    label: "High tension",
  },
};

const REVIEWED = "2026-10-27";

export const CONFLICT_ZONES = [
  {
    id: "ukraine_front",
    name: "Russia–Ukraine war front",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [50.7, 35.5], // Sumy / Belgorod border
      [50.1, 36.8], // Kharkiv north, Vovchansk
      [49.5, 37.5], // Kupiansk / Izium
      [48.9, 37.9], // Lyman / Siversk
      [48.55, 37.9], // Bakhmut / Kostiantynivka
      [48.3, 37.2], // Pokrovsk
      [47.85, 36.85], // Velyka Novosilka
      [47.65, 36.25], // Huliaipole
      [47.5, 35.2], // Zaporizhzhia front / Enerhodar
      [46.7, 33.2], // Kherson / Dnipro river
    ],
  },
  {
    id: "gaza",
    name: "Gaza",
    status: "war",
    resolution: 5,
    reviewed: REVIEWED,
    seeds: [
      [31.52, 34.46], // Gaza City
      [31.42, 34.37], // Deir al-Balah
      [31.31, 34.27], // Khan Younis / Rafah
    ],
  },
  {
    id: "lebanon_border",
    name: "Israel–Lebanon border",
    status: "tension",
    resolution: 4,
    reviewed: REVIEWED,
    seeds: [[33.1, 35.4, 1]],
  },
  {
    id: "sudan",
    name: "Sudan civil war",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [15.5, 32.5], // Khartoum
      [13.2, 30.2], // El Obeid / Kordofan
      [13.6, 25.3], // El Fasher / Darfur
      [11.0, 29.7], // South Kordofan
    ],
  },
  {
    id: "myanmar",
    name: "Myanmar conflict",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [22.0, 95.5], // Sagaing
      [22.9, 97.75], // Northern Shan, Lashio
      [25.4, 97.4], // Kachin
      [20.15, 92.9], // Rakhine
      [19.6, 97.2], // Kayah / Karenni
    ],
  },
  {
    id: "drc_east",
    name: "Eastern DR Congo",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [-1.7, 29.2], // Goma / Bukavu (North & South Kivu)
      [0.5, 29.5], // Beni / Butembo
      [1.55, 30.25], // Bunia / Ituri
      [-3.4, 29.1], // Uvira / South Kivu
    ],
  },
  {
    id: "sahel",
    name: "Sahel insurgency",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [14.5, -4.2], // central Mali, Mopti
      [14.1, -1.6], // northern Burkina Faso, Djibo
      [14.2, 1.45], // Niger, Tillabéri
    ],
  },
  {
    id: "yemen",
    name: "Yemen war",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [15.4, 45.3], // Marib
      [14.8, 42.95], // Hodeidah
      [13.6, 44.0], // Taiz
    ],
  },
  {
    id: "somalia",
    name: "Somalia conflict",
    status: "war",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [2.05, 45.3], // Mogadishu / Shabelle
      [4.7, 45.2], // Beledweyne / Hiraan
      [-0.4, 42.55], // Kismayo / Lower Juba
    ],
  },
  {
    id: "ethiopia",
    name: "Ethiopia (Amhara / Tigray tensions)",
    status: "tension",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [
      [11.6, 37.4], // Amhara, Bahir Dar / Gojjam
      [11.1, 39.6], // Amhara, Dessie / Wollo
      [13.5, 39.5], // Tigray, Mekelle
    ],
  },
  {
    id: "haiti",
    name: "Haiti gang violence",
    status: "war",
    resolution: 4,
    reviewed: REVIEWED,
    seeds: [[18.55, -72.35, 1]],
  },
  {
    id: "korean_dmz",
    name: "Korean DMZ",
    status: "tension",
    resolution: 4,
    reviewed: REVIEWED,
    seeds: [
      [37.9, 126.7], // Panmunjom / Paju
      [38.2, 127.2], // Cheorwon
      [38.2, 127.9], // Yanggu / Inje
      [38.4, 128.4], // Goseong
    ],
  },
  {
    id: "taiwan_strait",
    name: "Taiwan Strait",
    status: "tension",
    resolution: 3,
    reviewed: REVIEWED,
    seeds: [[24.3, 119.6, 1]],
  },
];

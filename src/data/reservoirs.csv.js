// data/reservoirs.csv.js
//
// Observable Framework data loader. Runs at build time; stdout becomes
// data/reservoirs.csv, loaded in pages via FileAttachment("./data/reservoirs.csv"),
// exactly like ./data/RM10_water_temp.csv elsewhere in this project.
//
// STATUS: RISE fetch is real and active (fetchFromRise below actually calls
// data.usbr.gov). It is only used per-reservoir once that reservoir has an
// itemId filled in in RESERVOIRS. All six are filled in — see DATA SOURCE
// below for where those came from.
//
// NOTE: x/y placeholder coordinates have been REMOVED from this file. Map
// position now comes from src/Layers/Reservoirs.geojson (each polygon's
// centroid, projected in reservoirs.md), joined back to this csv's rows by
// `id`. This file is now purely attribute data: name, capacity, live/mock
// storage reading. See reservoirs.md for the join + projection logic.

import {csvFormat} from "d3-dsv";

// DATA SOURCE:
//   Each reservoir's itemId points to its "Daily Lake/Reservoir Storage-af"
//   time series item in USBR's RISE catalog (https://data.usbr.gov), found
//   via Catalog Search > reservoir name > the dam's catalog record >
//   "Daily Lake/Reservoir Storage-af Time Series Data" under Associated
//   Items > Time series. Each item's URL is data.usbr.gov/catalog/<recordId>/item/<itemId>.
//
//   Source records, for reference/re-verification:
//     Fontenelle:    https://data.usbr.gov/catalog/2305/item/347
//     Flaming Gorge: https://data.usbr.gov/catalog/2300/item/337
//     Morrow Point:  https://data.usbr.gov/catalog/2386/item/592
//     Blue Mesa:     https://data.usbr.gov/catalog/2249/item/76
//     Navajo:        https://data.usbr.gov/catalog/2392/item/613
//     Lake Powell:   https://data.usbr.gov/catalog/2362/item/509
//
//   To add a reservoir or re-source one that starts erroring (RISE
//   occasionally reorganizes catalog records): repeat the same lookup —
//   Catalog Search by name, open the dam's catalog record, open the item
//   titled "...Daily Lake/Reservoir Storage-af Time Series Data" specifically
//   (not Inflow/Elevation/Evaporation/Bank Storage, which live alongside it
//   under the same record), confirm Parameter Unit: af and Time Step: daily,
//   then take the number after /item/ in that page's URL.
//
// `id` values here MUST match the `id` property you set on each feature in
// src/Layers/Reservoirs.geojson — that's how reservoirs.md joins position
// (from the geojson) to name/capacity/storage (from this csv).
const RESERVOIRS = [
  { id: "fontenelle",  name: "Fontenelle",    itemId: 347, capacity: 333960   },
  { id: "flaming",     name: "Flaming Gorge", itemId: 337, capacity: 3788900  },
  { id: "morrowpoint", name: "Morrow Point",  itemId: 592, capacity: 117025   },
  { id: "bluemesa",    name: "Blue Mesa",     itemId: 76,  capacity: 827940   },
  { id: "navajo",      name: "Navajo",        itemId: 613, capacity: 1647900  },
  { id: "powell",      name: "Lake Powell",   itemId: 509, capacity: 25160000 },
];

// ── Real data: RISE API ──────────────────────────────────────────────
// Actually fetches. Used automatically once a reservoir has an itemId.
//
// Two fixes layered on top of the original plain fetch:
//
// 1. Date-range narrowing via dateTime[after]/dateTime[before]. RISE's
//    Result endpoint uses JSON:API-style bracketed filter fields — see
//    the documented example query:
//      https://data.usbr.gov/rise/api/result?locationId=1533&parameterId=3
//        &dateTime[before]=2024-05-01&dateTime[after]=2024-01-01
//        &catalogItem.isModeled=false
//    A previous version of this loader sent flat `after=`/`before=`
//    params instead of `dateTime[after]`/`dateTime[before]`. Those aren't
//    filter fields RISE recognizes, so the server silently ignored them —
//    the query degraded to an effectively unbounded itemId+order+pageSize
//    request, which is exactly what was timing out (504) in the first
//    place for reservoirs with long periods of record (Flaming Gorge,
//    Navajo, Lake Powell — Powell's record alone goes back to 1963).
//    Fontenelle/Morrow Point/Blue Mesa have shorter histories, so the
//    unbounded sort-then-truncate finished fast enough to mask the bug.
//    Using the correct bracketed field names actually scopes the query
//    server-side to the requested window.
//
//    Dates are sent as plain YYYY-MM-DD (matching RISE's documented
//    example), not full ISO timestamps — the API's date filters appear
//    to be date-granularity, and there's no indication they accept or
//    expect a time-of-day/timezone component.
//
// 2. Retry with backoff on 504 specifically. A 504 is a gateway timeout,
//    which can still happen under transient load even with a properly
//    scoped query — worth a couple of short-delay retries before giving
//    up. Other error codes (404, 406, etc.) are not retried, since
//    retrying won't change the outcome for those.
function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchFromRise(reservoir, attempt = 1) {
  const now = new Date();
  const after = toDateOnly(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));
  const before = toDateOnly(now);
  const url = `https://data.usbr.gov/rise/api/result?itemId=${reservoir.itemId}&dateTime%5Bafter%5D=${encodeURIComponent(after)}&dateTime%5Bbefore%5D=${encodeURIComponent(before)}&order=DESC&pageSize=1`;

  const res = await fetch(url, {headers: {Accept: "application/vnd.api+json"}});

  if (!res.ok) {
    if (res.status === 504 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1000)); // 1s, then 2s
      return fetchFromRise(reservoir, attempt + 1);
    }
    throw new Error(`RISE fetch failed for ${reservoir.name} (item ${reservoir.itemId}): ${res.status}`);
  }

  const json = await res.json();
  const attrs = json?.data?.[0]?.attributes;
  if (!attrs) {
    throw new Error(`RISE returned no results for ${reservoir.name} (item ${reservoir.itemId})`);
  }
  return {
    date: attrs.dateTime ? attrs.dateTime.slice(0, 10) : null,
    storage: attrs.result ?? null,
  };
}

// ── Mock fallback (active by default until itemIds are filled in) ───
function generateMockReadings(reservoir) {
  // Deterministic-ish pseudo-random fill level per reservoir, seeded by
  // id, so re-running the loader doesn't produce wildly different demo
  // numbers every build.
  let seed = [...reservoir.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const pctFull = 35 + rand() * 55; // land somewhere in a plausible 35-90% band
  const storage = Math.round(reservoir.capacity * pctFull / 100);
  return {
    date: new Date().toISOString().slice(0, 10),
    storage,
  };
}

// ── Dispatch: real data if configured, mock otherwise ────────────────
async function getReadings(reservoir) {
  if (!reservoir.itemId) {
    return { ...generateMockReadings(reservoir), isMock: true, mockReason: "no itemId configured" };
  }
  try {
    const live = await fetchFromRise(reservoir);
    return { ...live, isMock: false, mockReason: "" };
  } catch (err) {
    // Fail soft into mock rather than breaking the whole build over one
    // reservoir's API hiccup — but say so loudly in the data itself.
    console.error(err.message);
    return { ...generateMockReadings(reservoir), isMock: true, mockReason: err.message };
  }
}

const rows = await Promise.all(
  RESERVOIRS.map(async (r) => {
    const { date, storage, isMock, mockReason } = await getReadings(r);
    return {
      id: r.id,
      name: r.name,
      date,
      storage,
      capacity: r.capacity,
      pctFull: storage != null ? +(100 * storage / r.capacity).toFixed(1) : null,
      isMock,
      mockReason,
    };
  })
);

process.stdout.write(csvFormat(rows));
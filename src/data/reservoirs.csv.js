// data/reservoirs.csv.js
//
// Observable Framework data loader. Runs at build time; stdout becomes
// data/reservoirs.csv, loaded in pages via FileAttachment("./data/reservoirs.csv"),
//

import {csvFormat} from "d3-dsv";

// DATA SOURCE:
//   Each reservoir's itemId points to its "Daily Lake/Reservoir Storage-af"
//   time series item in USBR's RISE catalog (https://data.usbr.gov), found
//   via Catalog Search > reservoir name > the dam's catalog record >
//   "Daily Lake/Reservoir Storage-af Time Series Data" under Associated
//   Items > Time series. Each item's URL is data.usbr.gov/catalog/<recordId>/item/<itemId>.
//
//   Source records
//     Fontenelle:    https://data.usbr.gov/catalog/2305/item/347
//     Flaming Gorge: https://data.usbr.gov/catalog/2300/item/337
//     Morrow Point:  https://data.usbr.gov/catalog/2386/item/592
//     Blue Mesa:     https://data.usbr.gov/catalog/2249/item/76
//     Navajo:        https://data.usbr.gov/catalog/2392/item/613
//     Lake Powell:   https://data.usbr.gov/catalog/2362/item/509
//

const RESERVOIRS = [
  { id: "fontenelle",  name: "Fontenelle",    itemId: 347, capacity: 333960   },
  { id: "flaming",     name: "Flaming Gorge", itemId: 337, capacity: 3788900  },
  { id: "morrowpoint", name: "Morrow Point",  itemId: 592, capacity: 117025   },
  { id: "bluemesa",    name: "Blue Mesa",     itemId: 76,  capacity: 827940   },
  { id: "navajo",      name: "Navajo",        itemId: 613, capacity: 1647900  },
  { id: "powell",      name: "Lake Powell",   itemId: 509, capacity: 25160000 },
];

// ── RISE API Data ──────────────────────────────────────────────
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

// ── Dispatch: real data only. No itemId or a failed fetch is fatal ───
async function getReadings(reservoir) {
  if (!reservoir.itemId) {
    throw new Error(`No itemId configured for ${reservoir.name}`);
  }
  return fetchFromRise(reservoir);
}

const rows = await Promise.all(
  RESERVOIRS.map(async (r) => {
    const { date, storage } = await getReadings(r);
    return {
      id: r.id,
      name: r.name,
      date,
      storage,
      capacity: r.capacity,
      pctFull: storage != null ? +(100 * storage / r.capacity).toFixed(1) : null,
    };
  })
);

process.stdout.write(csvFormat(rows));
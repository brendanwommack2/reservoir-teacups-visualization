---
title: Reservoir Tea-Cups
toc: false
---

<link rel="stylesheet" href="./styles/App.css">

```js
// Load reservoir metadata (name, storage, capacity) and the historical volume data
const histVolumeRaw = await FileAttachment("./data/Reservoir-storage-volume.csv").text();
const raw = await FileAttachment("./data/reservoirs.csv").text();
const reservoirMeta = d3.csvParse(raw, d => ({
  id: d.id,
  name: d.name,
  date: d.date,
  storage: +d.storage,
  capacity: +d.capacity,
  pctFull: +d.pctFull,
}));
```

```js
// Real geometry, exported from ArcPro. Basin and reservoir polygons were
// pre-fixed for ring winding in R (see scripts/fix_geometry.R) and loaded
// directly here.
const basin = await FileAttachment("./Layers/UpperBasin_simple.geojson").json();
const rivers = await FileAttachment("./Layers/Rivers.geojson").json();
const reservoirShapes = await FileAttachment("./Layers/Reservoirs_simple.geojson").json();
```

```js
// Walks any GeoJSON geometry type and calls fn(coord) on every raw coordinate pair
function forEachCoordinate(geometry, fn) {
  if (!geometry) return;
  const {type, coordinates} = geometry;
  if (type === "Point") fn(coordinates);
  else if (type === "MultiPoint" || type === "LineString") coordinates.forEach(fn);
  else if (type === "MultiLineString" || type === "Polygon") coordinates.forEach(ring => ring.forEach(fn));
  else if (type === "MultiPolygon") coordinates.forEach(poly => poly.forEach(ring => ring.forEach(fn)));
  else if (type === "GeometryCollection") geometry.geometries.forEach(g => forEachCoordinate(g, fn));
}

// Fits a projection's scale/translate to a set of feature collections by
// projecting every coordinate and taking the pixel bounding box directly,
// rather than relying on d3's fitExtent
function fitProjectionToFeatures(projection, featureCollections, [width, height], padding = 20) {
  projection.scale(1).translate([0, 0]);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const fc of featureCollections) {
    for (const f of fc.features) {
      forEachCoordinate(f.geometry, (coord) => {
        const p = projection(coord);
        if (!p) return;
        const [x, y] = p;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      });
    }
  }

  const dx = x1 - x0, dy = y1 - y0;
  const availW = width - 2 * padding, availH = height - 2 * padding;
  const scale = Math.min(availW / dx, availH / dy);
  const translate = [
    padding + (availW - scale * dx) / 2 - scale * x0,
    padding + (availH - scale * dy) / 2 - scale * y0,
  ];

  projection.scale(scale).translate(translate);
  return projection;
}
```

```js
// Nudges overlapping cup+label blocks apart (e.g. Fontenelle/Flaming Gorge)
// using a force simulation: each point springs weakly back toward its true
// position while a collision force keeps blocks from overlapping.
function declutterPositions(points, {radius = 60, strength = 0.15, iterations = 300} = {}) {
  const nodes = points.map(d => ({...d, x0: d.x, y0: d.y}));
  const sim = d3.forceSimulation(nodes)
    .force("x", d3.forceX(d => d.x0).strength(strength))
    .force("y", d3.forceY(d => d.y0).strength(strength))
    .force("collide", d3.forceCollide(radius))
    .stop();
  for (let i = 0; i < iterations; i++) sim.tick();
  return nodes;
}
```

```js
display(htl.html`
  <div class="data-current">
    Data Current as of:<br>${reservoirMeta[0]?.date ?? "—"}
  </div>
  <h1 class="reservoir-title">Upper Colorado River Drainage Basin</h1>
`);
```

```js
// Custom Plot mark: draws each reservoir as a tea-cup shape, filled to
// reflect % full. rx/ry (sqrt-scaled capacity/storage) control cup SIZE
// only. Fill level comes from the separate `pct` channel — NOT from rx/ry —
// since the scale's non-zero range floor ([10, 34]) means rx/ry aren't
// simple multiples of √capacity/√storage, so their ratio can't be squared
// back into an accurate percentage.
const CUP_BLUE = "#4650e0";
const LABEL_NAVY = "#1d3ec1";

class Teacup extends Plot.Mark {
  static defaults = {fill: CUP_BLUE, stroke: null};

  constructor(data, options = {}) {
    const {x, y, x0 = x, y0 = y, rx, ry, pct} = options;
    super(
      data,
      {
        // scale, null means use this value as a literal pixel number
        x: {value: x, scale: null},
        y: {value: y, scale: null},
        x0: {value: x0, scale: null},
        y0: {value: y0, scale: null},
        rx: {value: rx, scale: null},
        ry: {value: ry, scale: null},
        pct: {value: pct, scale: null},
      },
      options,
      Teacup.defaults
    );
  }

  render(indices, scales, channels, dimensions, cxt) {
    const {x: xs, y: ys, x0: x0s, y0: y0s, rx: rxs, ry: rys, pct: pcts} = channels;
    const data = this.data;

    return htl.svg`<g>${[...indices].map((i) => {
      const x = xs[i], y = ys[i];
      const x0 = x0s[i], y0 = y0s[i];
      const rx = rxs[i];

      const w = rx * 2;
      const h = w * 0.92;

      const pct = Math.min(1, Math.max(0, pcts[i]));
      const waterH = h * pct;

      // Trapezoid cup shape
      const topW = w, botW = w * 0.40;
      const cupD = `M ${-topW / 2},0 L ${topW / 2},0 L ${botW / 2},${h} L ${-botW / 2},${h} Z`;

      // If decluttering moved this point, draw a leader line back to its true position
      const displaced = Math.hypot(x - x0, y - y0) > 3;
      const clipId = `clip-teacup-${i}`;

      const d = data[i] ?? {};
      const name = d.name ?? "";
      const storage = d.storage ?? 0;
      const capacity = d.capacity ?? 0;

      return htl.svg`<g class="reservoir">
        ${displaced
          ? htl.svg`<g class="leader">
              <line x1="${x0}" y1="${y0}" x2="${x}" y2="${y - h / 2}"
                    stroke="#8892e6" stroke-width="1" stroke-dasharray="2,2" />
              <circle cx="${x0}" cy="${y0}" r="2" fill="${CUP_BLUE}" />
            </g>`
          : null}
        <g class="node" transform="translate(${x - w / 2}, ${y - h / 2})">
          <clipPath id="${clipId}"><path d="${cupD}" /></clipPath>
          <rect class="cup-water"
                x="${-w / 2}" y="${h - waterH}" width="${w}" height="${waterH}"
                fill="${CUP_BLUE}" clip-path="url(#${clipId})" />
          <path class="cup-outline" d="${cupD}"
                fill="none" stroke="${CUP_BLUE}" stroke-width="1.5" />
          <text x="0" y="${h + 15}" text-anchor="middle"
                font-size="11" font-weight="700" fill="${LABEL_NAVY}">${name}</text>
          <text x="0" y="${h + 27}" text-anchor="middle"
                font-size="9.5" fill="${LABEL_NAVY}">${storage.toLocaleString()}/${capacity.toLocaleString()}</text>
          <text x="0" y="${h + 39}" text-anchor="middle"
                font-size="9.5" fill="${LABEL_NAVY}">${Math.round(pct * 100)}% Full</text>
        </g>
      </g>`;
    })}</g>`;
  }
}

// Sqrt scale so cup AREA (not radius) scales linearly with capacity
function makeRScale(data, range = [10, 34]) {
  return d3.scaleSqrt()
    .domain([0, d3.max(data, d => d.capacity)])
    .range(range)
    .clamp(true);
}
```

```js
const mapEl = resize((width) => {
  const height = 620;
  const padding = 20;

  // Fit the projection to the basin outline, then reuse it for everything else
  // (reservoir centroids, Plot.geo layers) so it all lines up in the same pixel space
  const projection = d3.geoMercator();
  fitProjectionToFeatures(projection, [basin], [width, height], padding);
  const path = d3.geoPath(projection);

  // Join reservoir geometry with metadata (from the csv) by id,
  // get each reservoir's pixel position via its polygon centroid
  const reservoirPoints = reservoirShapes.features
    .map(f => {
      const meta = reservoirMeta.find(r => r.id === f.properties.id);
      if (!meta) {
        console.warn(`No csv match for geojson feature id="${f.properties.id}"`);
        return null;
      }
      const [x, y] = path.centroid(f);
      return {...meta, x, y};
    })
    .filter(Boolean);

  const rScale = makeRScale(reservoirPoints);
  const declustered = declutterPositions(reservoirPoints).map(d => ({
    ...d,
    rx: rScale(d.capacity),
    ry: rScale(d.storage),
    pct: d.capacity > 0 ? d.storage / d.capacity : 0,
  }));

  const plot = Plot.plot({
    width,
    height,
    margin: 0,
    projection,
    marks: [
      // Basin outline
      Plot.geo(basin.features, {
        fill: "#ffffff",
        stroke: "#1a1a1a",
        strokeWidth: 1.5,
      }),
      // Rivers
      Plot.geo(rivers.features, {
        fill: "none",
        stroke: "#5bb8e8",
        strokeWidth: 1.5,
      }),
      // Reservoir waterbody outlines, drawn under the tea-cups
      Plot.geo(reservoirShapes.features, {
        fill: "#5bb8e8",
        fillOpacity: 0.6,
        stroke: "#1d3ec1",
        strokeWidth: 1,
      }),
      // Tea-cups on top
      new Teacup(declustered, {x: "x", y: "y", x0: "x0", y0: "y0", rx: "rx", ry: "ry", pct: "pct"}),
    ],
  });

  d3.select(plot)
    .append("text")
    .attr("x", width / 2)
    .attr("y", height - 15)
    .attr("text-anchor", "middle")
    .attr("font-size", 12)
    .attr("font-weight", 600)
    .text("Drainage Area 107,838 Square Miles");

  return plot;
});
display(mapEl);
```

```js
display(htl.html`<p class="page-footer">
  Data through ${reservoirMeta[0]?.date ?? "—"} · USBR RISE, preliminary
</p>`);
```

---

## Historical Comparison

```js
// Parse the full historical series: Location, Date, Volume (see 1-Update-data.R).
// Location values are already lowercased in the R loader to match reservoirMeta.id.
const histVolumeRaw = await FileAttachment("./data/Reservoir-storage-volume.csv").text();
// Location values in the historical CSV don't always match reservoirMeta.id exactly
// (e.g. reservoirMeta uses "flaming"/"powell", historical CSV uses "flaminggorge"/"lakepowell").
const idFixups = { flaminggorge: "flaming", lakepowell: "powell" };
const histVolume = d3.csvParse(histVolumeRaw, d => ({
  id: idFixups[d.Location] ?? d.Location,
  date: d.Date, // "YYYY-MM-DD" string — safe to compare/sort lexically
  volume: d.Volume === "" ? NaN : +d.Volume,
})).filter(d => !Number.isNaN(d.volume));

// Group by reservoir id, sorted by date, for fast "value on/near date X" lookups
const histByReservoir = d3.group(histVolume, d => d.id);
for (const arr of histByReservoir.values()) arr.sort((a, b) => d3.ascending(a.date, b.date));

// Distinct dates across all reservoirs — drives both the date picker range and the slider steps
const histDates = Array.from(new Set(histVolume.map(d => d.date))).sort(d3.ascending);

// Given a reservoir id and a target date string, find the closest recorded date <= target
function findHistoricalRecord(id, targetDate) {
  const series = histByReservoir.get(id);
  if (!series || series.length === 0) return null;
  let lo = 0, hi = series.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= targetDate) { best = series[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best ?? series[0];
}
```

```js
// Snaps an arbitrary Date (or "YYYY-MM-DD" string) to the nearest date
// actually present in histDates.
const histDateExtent = [histDates[0], histDates[histDates.length - 1]];
const defaultHistDate = histDates[Math.max(0, histDates.length - 1 - 365)];

function nearestHistDate(dateInput) {
  if (!dateInput) return histDateExtent[1];
  const target = typeof dateInput === "string" ? dateInput : d3.utcFormat("%Y-%m-%d")(dateInput);
  const bisect = d3.bisector(d => d).left;
  const i = bisect(histDates, target);
  if (i <= 0) return histDates[0];
  if (i >= histDates.length) return histDates[histDates.length - 1];
  // Pick whichever neighboring available date is closer to the typed/picked/scrubbed date
  const before = histDates[i - 1], after = histDates[i];
  return (target - before <= after - target) ? before : after;
}
```

```js
// Combined control: a native date picker + a bare range slider (no numeric
// spinbox — we skip Inputs.range since it pairs the slider with a raw
// number field we don't want), both scrubbing the same position in
// histDates. Either one can drive the other; the emitted value is always
// a snapped "YYYY-MM-DD" string.
function historicalDateControl({dates, initial}) {
  const initialDate = nearestHistDate(initial);
  const initialIndex = Math.max(0, dates.indexOf(initialDate));

  const dateInput = Inputs.date({
    value: new Date(`${initialDate}T00:00:00`),
    min: dates[0],
    max: dates[dates.length - 1],
  });

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = 0;
  slider.max = dates.length - 1;
  slider.step = 1;
  slider.value = initialIndex;

  const wrap = document.createElement("div");
  wrap.className = "hist-date-control";

  const label = document.createElement("span");
  label.className = "hist-date-label";
  label.textContent = "Compare to date:";

  wrap.append(label, dateInput, slider);

  let value = initialDate;
  let syncing = false;

  Object.defineProperty(wrap, "value", {
    get: () => value,
    set(v) {
      value = v;
      const idx = dates.indexOf(v);
      if (idx >= 0 && +slider.value !== idx) slider.value = idx;
      const asDate = new Date(`${v}T00:00:00`);
      if (+dateInput.value !== +asDate) dateInput.value = asDate;
    },
  });

  dateInput.addEventListener("input", (event) => {
    event.stopPropagation();
    if (syncing) return;
    syncing = true;
    wrap.value = nearestHistDate(dateInput.value);
    wrap.dispatchEvent(new Event("input", {bubbles: true}));
    syncing = false;
  });

  slider.addEventListener("input", (event) => {
    event.stopPropagation();
    if (syncing) return;
    syncing = true;
    wrap.value = dates[+slider.value];
    wrap.dispatchEvent(new Event("input", {bubbles: true}));
    syncing = false;
  });

  return wrap;
}

const selectedHistDate = view(historicalDateControl({dates: histDates, initial: defaultHistDate}));
```

```js
// Kept in its own cell: `selectedHistDate` above comes from view(), and
// Framework only resolves that generator to its current value for cells
// *downstream* of the one that declared it — reading it back in the same
// cell prints the raw AsyncGenerator object instead of the date string.
display(htl.html`
  <div class="hist-compare-caption">
    Historical (amber) — <b>${selectedHistDate}</b> &nbsp;vs&nbsp; Current (blue) — <b>${reservoirMeta[0]?.date ?? "—"}</b>
  </div>
`);
```

```js
// Small-multiples mark: same trapezoid teacup shape as the map, but drawn
// as a standalone SVG per reservoir (no geo projection / decluttering needed
// since these are laid out in a simple grid).
const GHOST_AMBER = "#c1732c";

function drawPairedCup(container, {name, currentPct, currentStorage, currentCapacity, histPct, histVolume, histDate}) {
  const w = 90, h = 82, gap = 26;
  const totalW = w * 2 + gap;
  // topMargin makes room for the reservoir-name label above the cups.
  // (Previously the label was drawn at y="-6", above the viewBox's y=0
  // origin, so it was silently clipped and never visible.)
  const topMargin = 20;
  const svgHeight = h + 56 + topMargin;

  const svg = d3.select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${totalW} ${svgHeight}`)
    .attr("width", totalW)
    .attr("height", svgHeight);

  function cup(g, {pct, color, dashed, label, sub}) {
    const topW = w, botW = w * 0.40;
    const cupD = `M ${-topW / 2},0 L ${topW / 2},0 L ${botW / 2},${h} L ${-botW / 2},${h} Z`;
    const waterH = h * Math.min(1, Math.max(0, pct));
    const clipId = `clip-${Math.random().toString(36).slice(2)}`;

    g.append("clipPath").attr("id", clipId).append("path").attr("d", cupD);
    g.append("rect")
      .attr("x", -w / 2).attr("y", h - waterH).attr("width", w).attr("height", waterH)
      .attr("fill", color).attr("fill-opacity", dashed ? 0.35 : 1)
      .attr("clip-path", `url(#${clipId})`);
    g.append("path")
      .attr("d", cupD).attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.5)
      .attr("stroke-dasharray", dashed ? "3,2" : null);
    g.append("text")
      .attr("x", 0).attr("y", h + 15).attr("text-anchor", "middle")
      .attr("font-size", 10).attr("font-weight", 700).attr("fill", color)
      .text(label);
    g.append("text")
      .attr("x", 0).attr("y", h + 27).attr("text-anchor", "middle")
      .attr("font-size", 9).attr("fill", color)
      .text(sub);
    g.append("text")
      .attr("x", 0).attr("y", h + 39).attr("text-anchor", "middle")
      .attr("font-size", 9).attr("font-weight", 700).attr("fill", color)
      .text(`${Math.round(pct * 100)}% Full`);
  }

  // Historical cup, left
  cup(svg.append("g").attr("transform", `translate(${w / 2}, ${topMargin})`), {
    pct: histPct,
    color: GHOST_AMBER,
    dashed: true,
    label: histDate ?? "no data",
    sub: histVolume != null ? Math.round(histVolume).toLocaleString() : "—",
  });

  // Current cup, right
  cup(svg.append("g").attr("transform", `translate(${w * 1.5 + gap}, ${topMargin})`), {
    pct: currentPct,
    color: CUP_BLUE_LOCAL,
    dashed: false,
    label: "Current",
    sub: `${Math.round(currentStorage).toLocaleString()}/${Math.round(currentCapacity).toLocaleString()}`,
  });

  // Reservoir name header sits in the topMargin band, above both cups
  svg.insert("text", ":first-child")
    .attr("x", totalW / 2).attr("y", topMargin - 6).attr("text-anchor", "middle")
    .attr("font-size", 12.5).attr("font-weight", 700).attr("fill", LABEL_NAVY)
    .text(name);
}

const CUP_BLUE_LOCAL = "#4650e0";
```

```js
const historicalGrid = (() => {
  const wrap = document.createElement("div");
  wrap.className = "historical-grid";

  for (const meta of reservoirMeta) {
    const rec = findHistoricalRecord(meta.id, selectedHistDate);
    const histVol = rec?.volume ?? null;
    const histPct = histVol != null && meta.capacity > 0 ? Math.min(1, histVol / meta.capacity) : 0;
    const currentPct = meta.capacity > 0 ? meta.storage / meta.capacity : 0;

    const cell = document.createElement("div");
    drawPairedCup(cell, {
      name: meta.name,
      currentPct,
      currentStorage: meta.storage,
      currentCapacity: meta.capacity,
      histPct,
      histVolume: histVol,
      histDate: rec?.date,
    });
    wrap.appendChild(cell);
  }
  return wrap;
})();
display(historicalGrid);
```
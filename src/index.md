---
title: Reservoir Tea-Cups
toc: false
---

<link rel="stylesheet" href="./styles/App.css">

```js
// Load reservoir metadata (name, storage, capacity), the historical volume
// series, and the map geometry, all up front.
const raw = await FileAttachment("./data/reservoirs.csv").text();
const reservoirMeta = d3.csvParse(raw, d => ({
  id: d.id,
  name: d.name,
  date: d.date,
  storage: +d.storage,
  capacity: +d.capacity,
  pctFull: +d.pctFull,
}));

const histVolumeRaw = await FileAttachment("./data/Reservoir-storage-volume.csv").text();
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
// rather than relying on d3's fitExtent. `padding` can be a single number
// (uniform on all sides) or a {top, right, bottom, left} object — the
// latter lets callers reserve extra room on one side (e.g. more space at
// the bottom for cups/labels) without shrinking the whole map evenly.
function fitProjectionToFeatures(projection, featureCollections, [width, height], padding = 20) {
  const pad = typeof padding === "number"
    ? {top: padding, right: padding, bottom: padding, left: padding}
    : {top: 20, right: 20, bottom: 20, left: 20, ...padding};

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
  const availW = width - pad.left - pad.right;
  const availH = height - pad.top - pad.bottom;
  const scale = Math.min(availW / dx, availH / dy);
  const translate = [
    pad.left + (availW - scale * dx) / 2 - scale * x0,
    pad.top + (availH - scale * dy) / 2 - scale * y0,
  ];

  projection.scale(scale).translate(translate);
  return projection;
}
```

```js
// Nudges overlapping cup+label blocks apart (e.g. Fontenelle/Flaming Gorge)
// using a force simulation. Two things pull on each point:
//   1. A radial "push" that first nudges each point's *target* outward from
//      the map's center by `pushDist` pixels — so a cup's resting position is
//      a little off the basin outline near its true spot, rather than
//      sitting on top of it.
//   2. forceX/forceY spring each node back toward that pushed target
//      (not the true position) while forceCollide keeps overlapping cups
//      from stacking on each other, nudging them further apart as needed.
// The map's own projection/size is untouched — this only affects where the
// cups land relative to it. `radius` needs to grow when paired historical
// cups are showing, since each "point" is then twice as wide.
function declutterPositions(points, center, {pushDist = 45, radius = 55, strength = 0.2, iterations = 300} = {}) {
  const nodes = points.map(d => {
    const dx = d.x - center.x, dy = d.y - center.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    // Target = true position pushed outward along the center->point ray
    const tx = d.x + ux * pushDist;
    const ty = d.y + uy * pushDist;
    return {...d, x0: d.x, y0: d.y, x: tx, y: ty, tx, ty};
  });
  const sim = d3.forceSimulation(nodes)
    .force("x", d3.forceX(d => d.tx).strength(strength))
    .force("y", d3.forceY(d => d.ty).strength(strength))
    .force("collide", d3.forceCollide(radius))
    .stop();
  for (let i = 0; i < iterations; i++) sim.tick();
  return nodes;
}
```

```js
// Reads a CSS custom property's live value off :root, so App.css is the
// single source of truth for color — nothing in this file hardcodes a hex
// value. Falls back to `fallback` if the variable isn't set (e.g. running
// before stylesheets have loaded).
function cssVar(name, fallback = "#000000") {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Shared color constants, read once from App.css's :root custom properties.
// Declared once here so every cup-drawing cell — the map tea-cups (both
// single and paired-historical) and the system-total cup — stays in sync,
// and so a designer can change every color on the page by editing App.css
// alone, without touching this file.
const CUP_BLUE = cssVar("--water-teal", "#2C6E76");
const LABEL_NAVY = cssVar("--ink-navy", "#1B2A44");
const GHOST_AMBER = cssVar("--clay-amber", "#A85C2E");
const BASIN_FILL = cssVar("--paper-panel", "#FBFAF5");
const RIVER_STROKE = cssVar("--river-blue", "#6FA3AA");
const RESERVOIR_FILL = cssVar("--river-blue", "#6FA3AA");
const LEADER_STROKE = cssVar("--leader-line", "#8892e6");
```

```js
// Shared trapezoid "teacup" drawer, used by the system-total cup. Labels
// get a white halo (stroke behind fill, via paint-order) so they stay
// legible over any background, and lines are spaced ~13px apart.
function drawCupShape(g, {w, h, pct, color, dashed = false, label, sub}) {
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
    .attr("x", 0).attr("y", h + 16).attr("text-anchor", "middle")
    .attr("font-size", 10).attr("font-weight", 700).attr("fill", color)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(label);
  g.append("text")
    .attr("x", 0).attr("y", h + 29).attr("text-anchor", "middle")
    .attr("font-size", 9).attr("fill", color)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(sub);
  g.append("text")
    .attr("x", 0).attr("y", h + 42).attr("text-anchor", "middle")
    .attr("font-size", 9).attr("font-weight", 700).attr("fill", color)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(`${Math.round(pct * 100)}% Full`);
}
```

```js
// Draws a single reservoir tea-cup (non-historical view) directly onto an
// existing D3 selection — a plain SVG overlay on top of the Plot map, using
// the same technique as drawCupShape/the system-total cup above. Not a
// Plot.Mark: it just needs the pixel x/y Plot's own projection already gave
// us via path.centroid(), so there's no dependency on Plot's channel/scale
// pipeline at all. Labels get a white halo (paint-order stroke) so they
// stay legible over rivers/basin lines, with ~13px between lines.
function drawSingleMapCup(layer, d) {
  const {x, y, x0, y0, rx, pct, name, storage, capacity} = d;
  const w = rx * 2;
  const h = w * 0.92;
  const topW = w, botW = w * 0.40;
  const cupD = `M ${-topW / 2},0 L ${topW / 2},0 L ${botW / 2},${h} L ${-botW / 2},${h} Z`;
  const waterH = h * Math.min(1, Math.max(0, pct));
  const displaced = Math.hypot(x - x0, y - y0) > 3;
  const clipId = `clip-teacup-${Math.random().toString(36).slice(2)}`;

  const g = layer.append("g").attr("class", "reservoir");

  if (displaced) {
    const leader = g.append("g").attr("class", "leader");
    leader.append("line")
      .attr("x1", x0).attr("y1", y0).attr("x2", x).attr("y2", y - h / 2)
      .attr("stroke", LEADER_STROKE).attr("stroke-width", 1).attr("stroke-dasharray", "2,2");
    leader.append("circle").attr("cx", x0).attr("cy", y0).attr("r", 2).attr("fill", CUP_BLUE);
  }

  const node = g.append("g").attr("class", "node").attr("transform", `translate(${x - w / 2}, ${y - h / 2})`);
  node.append("clipPath").attr("id", clipId).append("path").attr("d", cupD);
  node.append("rect").attr("class", "cup-water")
    .attr("x", -w / 2).attr("y", h - waterH).attr("width", w).attr("height", waterH)
    .attr("fill", CUP_BLUE).attr("clip-path", `url(#${clipId})`);
  node.append("path").attr("class", "cup-outline").attr("d", cupD)
    .attr("fill", "none").attr("stroke", CUP_BLUE).attr("stroke-width", 1.5);
  node.append("text").attr("x", 0).attr("y", h + 16).attr("text-anchor", "middle")
    .attr("font-size", 11).attr("font-weight", 700).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(name);
  node.append("text").attr("x", 0).attr("y", h + 29).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(`${storage.toLocaleString()}/${capacity.toLocaleString()}`);
  node.append("text").attr("x", 0).attr("y", h + 42).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("font-weight", 700).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(`${Math.round(pct * 100)}% Full`);
}
```

```js
// Draws a PAIRED reservoir tea-cup (historical view): historical (amber,
// dashed) on the left, current (teal, solid) on the right, sharing one
// name label above them. Same overlay technique as drawSingleMapCup, same
// halo/spacing treatment on all text.
function drawPairedMapCup(layer, d) {
  const {x, y, x0, y0, rx, pct, name, storage, capacity, histPct, histVolume} = d;
  const hasHist = histVolume != null;
  const clampedHistPct = Math.min(1, Math.max(0, histPct ?? 0));
  const clampedPct = Math.min(1, Math.max(0, pct));

  const cupW = rx * 2;
  const h = cupW * 0.92;
  const gap = 10;
  const topW = cupW, botW = cupW * 0.40;
  const cupD = `M ${-topW / 2},0 L ${topW / 2},0 L ${botW / 2},${h} L ${-botW / 2},${h} Z`;
  const leftDx = -(cupW + gap) / 2;
  const rightDx = (cupW + gap) / 2;
  const waterHHist = h * clampedHistPct;
  const waterHCur = h * clampedPct;
  const displaced = Math.hypot(x - x0, y - y0) > 3;
  const rand = Math.random().toString(36).slice(2);
  const clipIdHist = `clip-teacup-hist-${rand}`;
  const clipIdCur = `clip-teacup-cur-${rand}`;

  const g = layer.append("g").attr("class", "reservoir reservoir-paired");

  if (displaced) {
    const leader = g.append("g").attr("class", "leader");
    leader.append("line")
      .attr("x1", x0).attr("y1", y0).attr("x2", x).attr("y2", y - h / 2)
      .attr("stroke", LEADER_STROKE).attr("stroke-width", 1).attr("stroke-dasharray", "2,2");
    leader.append("circle").attr("cx", x0).attr("cy", y0).attr("r", 2).attr("fill", CUP_BLUE);
  }

  const pair = g.append("g").attr("class", "node-pair").attr("transform", `translate(${x}, ${y - h / 2})`);

  pair.append("text").attr("x", 0).attr("y", -6).attr("text-anchor", "middle")
    .attr("font-size", 11).attr("font-weight", 700).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(name);

  const hist = pair.append("g").attr("class", "node hist").attr("transform", `translate(${leftDx}, 0)`);
  hist.append("clipPath").attr("id", clipIdHist).append("path").attr("d", cupD);
  if (hasHist) {
    hist.append("rect")
      .attr("x", -cupW / 2).attr("y", h - waterHHist).attr("width", cupW).attr("height", waterHHist)
      .attr("fill", GHOST_AMBER).attr("fill-opacity", 0.35).attr("clip-path", `url(#${clipIdHist})`);
  }
  hist.append("path").attr("d", cupD).attr("fill", "none")
    .attr("stroke", GHOST_AMBER).attr("stroke-width", 1.5).attr("stroke-dasharray", "3,2");
  hist.append("text").attr("x", 0).attr("y", h + 15).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("fill", GHOST_AMBER)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(hasHist ? Math.round(histVolume).toLocaleString() : "no data");
  hist.append("text").attr("x", 0).attr("y", h + 28).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("font-weight", 700).attr("fill", GHOST_AMBER)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(hasHist ? `${Math.round(clampedHistPct * 100)}%` : "—");

  const cur = pair.append("g").attr("class", "node cur").attr("transform", `translate(${rightDx}, 0)`);
  cur.append("clipPath").attr("id", clipIdCur).append("path").attr("d", cupD);
  cur.append("rect")
    .attr("x", -cupW / 2).attr("y", h - waterHCur).attr("width", cupW).attr("height", waterHCur)
    .attr("fill", CUP_BLUE).attr("clip-path", `url(#${clipIdCur})`);
  cur.append("path").attr("d", cupD).attr("fill", "none").attr("stroke", CUP_BLUE).attr("stroke-width", 1.5);
  cur.append("text").attr("x", 0).attr("y", h + 15).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(Math.round(storage).toLocaleString());
  cur.append("text").attr("x", 0).attr("y", h + 28).attr("text-anchor", "middle")
    .attr("font-size", 9.5).attr("font-weight", 700).attr("fill", LABEL_NAVY)
    .attr("stroke", "white").attr("stroke-width", 3).attr("paint-order", "stroke")
    .text(`${Math.round(clampedPct * 100)}%`);
}
```

```js
// Sqrt scale so cup AREA (not radius) scales linearly with capacity
function makeRScale(data, range = [10, 34]) {
  return d3.scaleSqrt()
    .domain([0, d3.max(data, d => d.capacity)])
    .range(range)
    .clamp(true);
}
```

```js
// System-wide totals: sum storage/capacity across all reservoirs currently
// loaded, and a big single cup to match — same visual language as the
// per-reservoir cups, but answering "how much water is in the system,
// total" rather than "where is it."
const totalStorage = d3.sum(reservoirMeta, d => d.storage);
const totalCapacity = d3.sum(reservoirMeta, d => d.capacity);
const systemPct = totalCapacity > 0 ? totalStorage / totalCapacity : 0;

// Formats an acre-feet total in millions, e.g. 14234000 -> "14.2M"
function formatAcFt(n) {
  return `${(n / 1e6).toFixed(1)}M`;
}

const systemCupEl = (() => {
  const w = 130, h = 120, topMargin = 20;
  const svgHeight = h + 56 + topMargin;

  const svg = d3.create("svg")
    .attr("viewBox", `0 0 ${w} ${svgHeight}`)
    .attr("width", w)
    .attr("height", svgHeight);

  drawCupShape(svg.append("g").attr("transform", `translate(${w / 2}, ${topMargin})`), {
    w, h,
    pct: systemPct,
    color: CUP_BLUE,
    label: "System Total",
    sub: `${formatAcFt(totalStorage)} / ${formatAcFt(totalCapacity)}`,
  });

  return svg.node();
})();
```

```js
display(htl.html`
  <div class="header-row">
    <div class="header-left">
      <div class="data-current">
        Data Current as of:<br>${reservoirMeta[0]?.date ?? "no data"}
      </div>
      <h1 class="reservoir-title">Upper Colorado River Drainage Basin</h1>
      <div class="system-stat">${formatAcFt(totalStorage)} / ${formatAcFt(totalCapacity)} ac-ft &nbsp;—&nbsp; ${Math.round(systemPct * 100)}% Full System-Wide</div>
    </div>
    <div class="header-right"><div class="system-cup-frame">${systemCupEl}</div></div>
  </div>
`);
```

```js
// Parse the full historical series: Location, Date, Volume (see 1-Update-data.R).
// Location values are already lowercased in the R loader to match reservoirMeta.id.
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

// Formats a Date as a local "YYYY-MM-DD" string (avoids UTC-offset drift
// that d3.utcFormat can introduce when stepping local calendar units).
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Steps a "YYYY-MM-DD" date string forward/back by whole calendar
// day/month/year units, then snaps the result onto the nearest date that
// actually exists in histDates (so a step never lands on a gap and the
// buttons always produce a *different* available date when one exists on
// that side).
function stepHistDate(dateStr, unit, direction) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (unit === "day") d.setDate(d.getDate() + direction);
  else if (unit === "month") d.setMonth(d.getMonth() + direction);
  else if (unit === "year") d.setFullYear(d.getFullYear() + direction);
  return nearestHistDate(formatLocalDate(d));
}
```

```js
// Combined control: an on/off "Historical" toggle, a native date picker,
// a bare range slider, and day/month/year step buttons — all bundled into
// one widget so the toggle state and the selected date travel together as
// a single reactive value: {enabled, date}. The date/slider/buttons stay
// mounted even while hidden, so scrubbing position isn't lost when the
// toggle is off.
function historicalToggleControl({dates, initial}) {
  const initialDate = nearestHistDate(initial);
  const initialIndex = Math.max(0, dates.indexOf(initialDate));

  const wrap = document.createElement("div");
  wrap.className = "hist-control-row";

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "hist-toggle-label";
  const toggleInput = document.createElement("input");
  toggleInput.type = "checkbox";
  const toggleText = document.createElement("span");
  toggleText.textContent = "Compare historic water levels";
  toggleLabel.append(toggleInput, toggleText);

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
  slider.className = "hist-slider";

  const sliderWrap = document.createElement("div");
  sliderWrap.className = "hist-slider-wrap";
  sliderWrap.append(dateInput, slider);

  // Step buttons: back/forward by day, month, and year, each rendered as
  // its own labeled segmented-control group (label on top, ‹ › below) so
  // three units of navigation stay legible side by side instead of
  // crowding into one line of text.
  function makeStepButton(unit, direction, glyph, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hist-step-btn";
    btn.textContent = glyph;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      wrap.value = {...value, date: stepHistDate(value.date, unit, direction)};
      wrap.dispatchEvent(new Event("input", {bubbles: true}));
    });
    return btn;
  }

  function makeStepGroup(unit, labelText) {
    const group = document.createElement("div");
    group.className = "hist-step-group";
    const label = document.createElement("span");
    label.className = "hist-step-group-label";
    label.textContent = labelText;
    const buttons = document.createElement("div");
    buttons.className = "hist-step-group-buttons";
    buttons.append(
      makeStepButton(unit, -1, "‹", `Back 1 ${labelText.toLowerCase()}`),
      makeStepButton(unit, 1, "›", `Forward 1 ${labelText.toLowerCase()}`),
    );
    group.append(label, buttons);
    return group;
  }

  const stepWrap = document.createElement("div");
  stepWrap.className = "hist-step-buttons";
  stepWrap.append(
    makeStepGroup("year", "Year"),
    makeStepGroup("month", "Month"),
    makeStepGroup("day", "Day"),
  );

  const dateWrap = document.createElement("div");
  dateWrap.className = "hist-date-inputs";
  dateWrap.append(sliderWrap, stepWrap);

  const caption = document.createElement("span");
  caption.className = "hist-compare-caption";

  wrap.append(toggleLabel, dateWrap, caption);

  let value = {enabled: false, date: initialDate};
  let syncing = false;

  function renderCaption() {
    caption.innerHTML = value.enabled
      ? `<span class="hist-tag hist-tag-amber">Historical</span> ${value.date} &nbsp;vs&nbsp; <span class="hist-tag hist-tag-teal">Current</span> ${reservoirMeta[0]?.date ?? "no data"}`
      : "";
  }

  Object.defineProperty(wrap, "value", {
    get: () => value,
    set(v) {
      value = v;
      toggleInput.checked = v.enabled;
      dateWrap.hidden = !v.enabled;
      const idx = dates.indexOf(v.date);
      if (idx >= 0 && +slider.value !== idx) slider.value = idx;
      const asDate = new Date(`${v.date}T00:00:00`);
      if (+dateInput.value !== +asDate) dateInput.value = asDate;
      renderCaption();
    },
  });

  toggleInput.addEventListener("change", (event) => {
    event.stopPropagation();
    wrap.value = {...value, enabled: toggleInput.checked};
    wrap.dispatchEvent(new Event("input", {bubbles: true}));
  });

  dateInput.addEventListener("input", (event) => {
    event.stopPropagation();
    if (syncing) return;
    syncing = true;
    wrap.value = {...value, date: nearestHistDate(dateInput.value)};
    wrap.dispatchEvent(new Event("input", {bubbles: true}));
    syncing = false;
  });

  slider.addEventListener("input", (event) => {
    event.stopPropagation();
    if (syncing) return;
    syncing = true;
    wrap.value = {...value, date: dates[+slider.value]};
    wrap.dispatchEvent(new Event("input", {bubbles: true}));
    syncing = false;
  });

  dateWrap.hidden = !value.enabled;
  renderCaption();
  return wrap;
}
```

```js
// The widget's raw DOM element, kept as its own plain (non-viewof) variable.
// This is the key to fixing the scroll-jump bug below: because the big map
// cell reads state from this element imperatively (via `.value` inside an
// event listener) instead of depending on a reactive `viewof` variable,
// dragging the slider (or clicking a step button) no longer causes
// Framework to recompute and replace the entire map cell — it only ever
// touches the small cups layer.
const historicalControlEl = historicalToggleControl({dates: histDates, initial: defaultHistDate});
const historicalState = view(historicalControlEl);
```

```js
const mapEl = resize((width) => {
  const height = 900;

  // Fit the projection to the basin outline with generous, asymmetric
  // padding: a modest margin on top/left/right, but a large bottom margin
  // (150px) so the basin itself sits higher in the canvas, leaving real
  // room below it for cups that get pushed downward during decluttering,
  // plus the "Drainage Area" footer text — none of which should ever
  // collide with the basin shape or each other.
  const fitPadding = {top: 24, right: 24, bottom: 150, left: 24};
  const projection = d3.geoMercator();
  fitProjectionToFeatures(projection, [basin], [width, height], fitPadding);
  const path = d3.geoPath(projection);

  const plot = Plot.plot({
    width,
    height,
    margin: 0,
    projection,
    marks: [
      // Basin outline — fill/stroke read from :root custom properties
      Plot.geo(basin.features, {
        fill: BASIN_FILL,
        stroke: LABEL_NAVY,
        strokeWidth: 1.5,
      }),
      // Rivers
      Plot.geo(rivers.features, {
        fill: "none",
        stroke: RIVER_STROKE,
        strokeWidth: 1.5,
      }),
      // Reservoir waterbody outlines, drawn under the tea-cups
      Plot.geo(reservoirShapes.features, {
        fill: RESERVOIR_FILL,
        fillOpacity: 0.55,
        stroke: LABEL_NAVY,
        strokeWidth: 1,
      }),
    ],
  });

  // Tea-cups are drawn as a plain SVG overlay on top of the Plot map,
  // reusing the pixel positions Plot's own projection already computed
  // above — not as a Plot mark, so there's nothing in Plot's own
  // rendering pipeline that can suppress them.
  const svg = d3.select(plot);
  const cupsLayer = svg.append("g").attr("class", "teacups-layer");

  // Pre-join reservoir geometry with metadata once — this part never
  // changes when the historical toggle/slider/step-buttons move, only the
  // historical lookup + declutter pass below does.
  const baseReservoirPoints = reservoirShapes.features
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

  const rScale = makeRScale(baseReservoirPoints, [14, 46]);

  // Center used as the origin for the "push outward" direction — the plot's
  // own center, so cups drift away from the middle of the map toward
  // whichever edge they're already closest to. Paired cups are drawn at
  // full single-cup width (two side by side), so their combined footprint
  // is roughly double a single cup's — push/radius scaled up accordingly.
  const mapCenter = {x: width / 2, y: height / 2};

  // Safety clamp: whatever the force simulation decides, no cup's center
  // should end up closer to an edge than `edgeMargin` px, or below
  // `bottomReserve` px from the bottom (leaves room for the cup's own
  // label stack below it, plus the footer text under that).
  const edgeMargin = 60;
  const bottomReserve = 110;

  // Redraws only the cups layer for a given {enabled, date} state — this
  // is what actually runs on every toggle flip / slider drag / date pick /
  // step-button click. It never touches the basin/rivers/reservoir-outline
  // marks above, so the browser never has to replace the big map DOM
  // subtree, and the page's scroll position stays put.
  function redrawCups({enabled: historicalMode, date: selectedHistDate}) {
    const reservoirPoints = baseReservoirPoints.map(meta => {
      const rec = historicalMode ? findHistoricalRecord(meta.id, selectedHistDate) : null;
      return {
        ...meta,
        histVolume: rec?.volume ?? null,
        histDate: rec?.date ?? null,
        histPct: rec != null && meta.capacity > 0 ? Math.min(1, rec.volume / meta.capacity) : 0,
      };
    });

    const declutterOpts = historicalMode
      ? {pushDist: 26, radius: 132, strength: 0.25, iterations: 400}
      : {pushDist: 18, radius: 68, strength: 0.25, iterations: 400};

    const declustered = declutterPositions(reservoirPoints, mapCenter, declutterOpts).map(d => ({
      ...d,
      x: Math.min(Math.max(d.x, edgeMargin), width - edgeMargin),
      y: Math.min(Math.max(d.y, edgeMargin), height - bottomReserve),
      rx: rScale(d.capacity),
      pct: d.capacity > 0 ? d.storage / d.capacity : 0,
    }));

    cupsLayer.selectAll("*").remove();
    for (const d of declustered) {
      if (historicalMode) {
        drawPairedMapCup(cupsLayer, d);
      } else {
        drawSingleMapCup(cupsLayer, d);
      }
    }
  }

  // Initial paint, using whatever the control's current value is right now
  // (read imperatively off the element, not off a reactive Framework var).
  redrawCups(historicalControlEl.value);

  // From here on, every toggle/date/slider/step-button interaction just
  // calls redrawCups directly — no cell rerun, no DOM replacement, no
  // scroll jump.
  const onHistoricalInput = () => redrawCups(historicalControlEl.value);
  historicalControlEl.addEventListener("input", onHistoricalInput);

  // This cell reruns on actual window resizes, which recreates the map and would otherwise pile
  // up duplicate listeners on historicalControlEl each time. `invalidation`
  // is Framework's built-in per-run cleanup hook — use it to remove the
  // listener we just added whenever this cell reruns or is torn down.
  invalidation.then(() => historicalControlEl.removeEventListener("input", onHistoricalInput));

  svg.append("text")
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
  Data through ${reservoirMeta[0]?.date ?? "no data"} · USBR RISE, preliminary
</p>`);
```
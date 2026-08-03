---
title: Reservoir Tea-Cups
toc: false
---

<link rel="stylesheet" href="./styles/App.css">

```js
// Load reservoir metadata (name, storage, capacity) and the historical volume data
const histVolume = await FileAttachment("./data/Reservoir-storage-volume.csv").text();
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
  <div style="font-family: monospace; color:#1d3ec1; font-size:12px;">
    Data Current as of:<br>${reservoirMeta[0]?.date ?? "—"}
  </div>
  <h1 style="text-align:center; margin-top:-8px; font-family: Georgia, 'Times New Roman', serif;">Upper Colorado River Drainage Basin</h1>
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
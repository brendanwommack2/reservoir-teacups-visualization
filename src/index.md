---
title: Reservoir Tea-Cups
toc: false
---

<link rel="stylesheet" href="./styles/App.css">

```js
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
// ── Ring-winding fix ─────────────────────────────────────────────────
// Uses d3.geoArea() (d3's own spherical area calc) to decide winding,
// rather than a hand-rolled planar shoelace check. On this project's
// large ArcPro-exported polygons, a custom planar shoelace check
// disagreed with d3.geoArea() and silently left rings un-flipped.
function reverseRing(ring) {
  return ring.slice().reverse();
}

function reversePolygonCoords(coords) {
  return coords.map(reverseRing);
}

function rewindFeature(f) {
  if (!f.geometry) return f;
  if (d3.geoArea(f) <= 2 * Math.PI) return f;

  const {type, coordinates} = f.geometry;
  let fixed = coordinates;
  if (type === "Polygon") {
    fixed = reversePolygonCoords(coordinates);
  } else if (type === "MultiPolygon") {
    fixed = coordinates.map(reversePolygonCoords);
  }
  return {...f, geometry: {...f.geometry, coordinates: fixed}};
}

function rewindGeoJSON(fc) {
  return {...fc, features: fc.features.map(rewindFeature)};
}
```

```js
// Real geometry, exported from ArcPro. All three layers rewound
const basinRaw = await FileAttachment("./Layers/UpperBasin.geojson").json();
const riversRaw = await FileAttachment("./Layers/Rivers.geojson").json();
const reservoirShapesRaw = await FileAttachment("./Layers/Reservoirs.geojson").json();

const basin = rewindGeoJSON(basinRaw);
const rivers = rewindGeoJSON(riversRaw);
const reservoirShapes = rewindGeoJSON(reservoirShapesRaw);
```

```js
// ── Projection fit, independent of ring winding ─────────────────────
// fitExtent() streams geometry through d3's clip/resample pipeline to
// compute bounds — the same machinery that ring winding can throw off.
// This instead projects every raw coordinate directly (bypassing clip/
// resample entirely) and takes a plain pixel min/max, so it can't be
// broken by winding even if a rewind pass upstream missed something.
//
// This fitted projection instance is handed straight to Plot.plot()
// below (as the `projection` option) rather than letting Plot compute
// its own fit — that keeps the geo layers and the hand-declustered
// tea-cup positions (computed with this same instance) in the exact
// same pixel space.
function forEachCoordinate(geometry, fn) {
  if (!geometry) return;
  const {type, coordinates} = geometry;
  if (type === "Point") fn(coordinates);
  else if (type === "MultiPoint" || type === "LineString") coordinates.forEach(fn);
  else if (type === "MultiLineString" || type === "Polygon") coordinates.forEach(ring => ring.forEach(fn));
  else if (type === "MultiPolygon") coordinates.forEach(poly => poly.forEach(ring => ring.forEach(fn)));
  else if (type === "GeometryCollection") geometry.geometries.forEach(g => forEachCoordinate(g, fn));
}

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
// ── Declutter overlapping cup+label blocks ───────────────────────────
// Fontenelle/Flaming Gorge (WY) and Morrow Point/Blue Mesa (CO) sit
// close enough geographically that their true centroids collide once
// you draw a cup + 3 lines of label text around each. Rather than
// hardcoding pixel nudges (which breaks on resize), each node gets a
// weak spring back to its true (x0, y0) position plus a collision
// force that pushes overlapping blocks apart until they clear.
//
// Runs in plain pixel space (via the fitted projection above) before
// the data ever reaches the Plot mark, since force-collision needs
// real screen distances, not lon/lat degrees.
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
// ── Tea-cup mark, as an Observable Plot custom Mark ──────────────────
// Take rx/ry as channels (capacity and storage respectively), and
// apply the reverse transform in render().
//
// Positions (x, y, x0, y0) and sizes (rx, ry) are all pre-computed in
// plain pixel units before this mark ever sees them — declustering and
// the projection fit both need real pixel space, not lon/lat — so every
// channel here is registered with `scale: null`, meaning "use this
// value as-is, don't run it through a Plot scale." Plot.geo's own
// `projection` (set on Plot.plot itself, using the exact same fitted
// projection instance) puts the basin/rivers/reservoir polygons in that
// same pixel space, so everything lines up.
//
// rx: reservoir CAPACITY, pushed through a sqrt ("r") scale -> cup
//     size on screen scales with capacity the way area should, so Lake
//     Powell visibly dwarfs Morrow Point instead of both being the same
//     fixed-size cup.
// ry: reservoir STORAGE, through that same sqrt scale -> a second,
//     smaller radius.
//
// Naively reading fill level off ry/rx would be wrong, because sqrt
// scaling distorts that ratio. Squaring it — (ry*ry)/(rx*rx) — reverses
// the sqrt transform and recovers the exact linear storage/capacity
// fraction again: whatever constant scale factor k the sqrt scale
// applied cancels out, since (k·√s / k·√c)^2 = s/c. 
const CUP_BLUE = "#4650e0";
const LABEL_NAVY = "#1d3ec1";

class Teacup extends Plot.Mark {
  static defaults = {fill: CUP_BLUE, stroke: null};

  constructor(data, options = {}) {
    const {x, y, x0 = x, y0 = y, rx, ry} = options;
    super(
      data,
      {
        // scale: null -> take the channel value as a literal pixel
        // number, rather than running it through a Plot x/y/r scale.
        x: {value: x, scale: null},
        y: {value: y, scale: null},
        x0: {value: x0, scale: null},
        y0: {value: y0, scale: null},
        rx: {value: rx, scale: null},
        ry: {value: ry, scale: null},
      },
      options,
      Teacup.defaults
    );
  }

  render(indices, scales, channels, dimensions, cxt) {
    const {x: xs, y: ys, x0: x0s, y0: y0s, rx: rxs, ry: rys} = channels;
    const data = this.data;

    return htl.svg`<g>${[...indices].map((i) => {
      const x = xs[i], y = ys[i];
      const x0 = x0s[i], y0 = y0s[i];
      const rx = rxs[i], ry = rys[i];

      const w = rx * 2;
      const h = w * 0.92;

      // The reverse transform: recover the true linear fraction from
      // the two sqrt-scaled radii.
      const pct = rx > 0 ? Math.min(1, Math.max(0, (ry * ry) / (rx * rx))) : 0;
      const waterH = h * pct;

      const topW = w, botW = w * 0.40;
      const cupD = `M ${-topW / 2},0 L ${topW / 2},0 L ${botW / 2},${h} L ${-botW / 2},${h} Z`;

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

// Sqrt ("r") scale: capacity -> on-screen cup radius. Domain starts at
// 0 so a hypothetical zero-capacity reservoir gets zero size; range
// floor is non-zero so the smallest real reservoir stays legible.
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

  const projection = d3.geoMercator();
  fitProjectionToFeatures(projection, [basin], [width, height], padding);
  const path = d3.geoPath(projection);

  // ── JOIN: geojson geometry (position) + csv (name/capacity/storage) ──
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
  }));

  const plot = Plot.plot({
    width,
    height,
    margin: 0,
    // Reuse the exact same fitted projection instance used above for
    // path.centroid(), so the geo layers and the tea-cups (positioned
    // in raw pixels via scale: null) share one coordinate space.
    projection,
    marks: [
      Plot.geo(basin.features, {
        fill: "#ffffff",
        stroke: "#1a1a1a",
        strokeWidth: 1.5,
      }),
      Plot.geo(rivers.features, {
        fill: "none",
        stroke: "#5bb8e8",
        strokeWidth: 1.5,
      }),
      // ── Reservoir polygons ──────────────────────────────────────
      // This layer draws waterbody shapes, styled to read as
      // an extension of the river-blue used above. Drawn after
      // rivers/basin so it sits above the basin fill, and before the
      // tea-cups so the cups and leader lines render on top of the
      // reservoir outlines.
      Plot.geo(reservoirShapes.features, {
        fill: "#5bb8e8",
        fillOpacity: 0.6,
        stroke: "#1d3ec1",
        strokeWidth: 1,
      }),
      new Teacup(declustered, {x: "x", y: "y", x0: "x0", y0: "y0", rx: "rx", ry: "ry"}),
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
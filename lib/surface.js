/*
 * A small 3D column chart that can be turned with the mouse, without a library. The columns stand on a floor with two axes, u and v, and their height is a value.
 * It is drawn on a canvas (one element, however many columns): the picture is first worked out as a list of polygons from the back to the front (buildScene, no DOM),
 * then painted. Drag to turn it, double click to put it back, the tooltip of the column under the mouse is the title of the canvas.
 *
 * columns3d is general: give it the columns and the labels of the axes. surfaceGraph is the use for the age maps of the analysis page.
 */
import { heatHue, heatOpacity, heatStrength, tickLabel, timeTicks } from "./chart.js";

const START_VIEW = { azimuth: 28, elevation: 38, zoom: 1, panX: 0, panY: 0 }; // degrees, a factor, and pixels of the picture
const ZOOM = { min: 0.5, max: 12, button: 1.15, wheel: 0.002 }; // the limits, the factor of one click on a button, and the log of the factor per pixel of the wheel (a notch is about 100 pixels: a factor of 1.22)
const TALLEST = 0.3;

/** The colours of the picture with the age in weeks: by the week of age, 1 week (not yet 7 days old) green, then yellow, orange, red, and everything older dark red. */
export const AGE_WEEK_COLORS = [{ hue: 120, shift: 0 }, { hue: 55, shift: 0 }, { hue: 30, shift: 0 }, { hue: 0, shift: 0 }, { hue: 0, shift: -22 }];
export const ageWeekColor = (row) => AGE_WEEK_COLORS[Math.min(row, AGE_WEEK_COLORS.length - 1)];
/** The CSS colour of one of them as the top of a column is drawn, for a legend. */
export const ageWeekCss = (row) => `hsl(${ageWeekColor(row).hue} 75% ${52 + ageWeekColor(row).shift}%)`; // the tallest column is this share of the longer side of the floor

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The projection of the point (u: along the first axis of the floor, v: along the second, h: height) for a view in degrees. Returns x and y on the screen (y down) and the depth:
 * a bigger depth is nearer to the viewer, so what is drawn first has the smallest.
 */
export function projector({ azimuth, elevation }) {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return (u, v, h) => {
    const x = u * Math.cos(a) + v * Math.sin(a);
    const depth = -u * Math.sin(a) + v * Math.cos(a);
    return { x, y: depth * Math.sin(e) - h * Math.cos(e), depth };
  };
}

/** The sides of a column that the viewer sees: the normal of the side points towards the viewer if its part along the depth axis is positive. */
export function visibleSides(azimuth) {
  const a = (azimuth * Math.PI) / 180;
  const eps = 1e-9; // a side that is seen exactly from the edge is not drawn
  return { plusU: -Math.sin(a) > eps, minusU: Math.sin(a) > eps, plusV: Math.cos(a) > eps, minusV: Math.cos(a) < -eps };
}

/**
 * Works out what to draw for a view: { floor, grid, texts, line, boxes }, all in the units of the picture (width x height). boxes are from the back to the front, each with
 * its faces [{ points, light }] (the top last), hue, opacity and title. See columns3d for the spec.
 */
export function buildScene({ columns, sizeU, sizeV, maxValue, ticksU = [], ticksV = [], gridV = 0, lineV = null, stretchV = 1, blockSize = 0, width, height }, view) {
  const project = projector(view);
  const unitHeight = (TALLEST * Math.max(sizeU, sizeV * stretchV)) / Math.max(1e-9, maxValue); // world height of one unit of value
  const floor = [[0, 0], [sizeU, 0], [sizeU, sizeV], [0, sizeV]];
  const pts = floor.flatMap(([u, v]) => [project(u, v * stretchV, 0), project(u, v * stretchV, maxValue * unitHeight)]);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = 22;
  const scale = Math.min((width - 2 * pad) / (maxX - minX || 1), (height - 2 * pad) / (maxY - minY || 1));
  const offX = pad + (width - 2 * pad - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = pad + (height - 2 * pad - (maxY - minY) * scale) / 2 - minY * scale;
  const zoom = view.zoom ?? 1;
  const panX = view.panX ?? 0;
  const panY = view.panY ?? 0;
  const at = (u, v, h) => {
    const p = project(u, v * stretchV, h); // v is in cells of the floor, stretchV makes them longer along that axis
    // zoomed around the middle of the picture, and moved
    return [(p.x * scale + offX - width / 2) * zoom + width / 2 + panX, (p.y * scale + offY - height / 2) * zoom + height / 2 + panY, p.depth];
  };
  const sides = visibleSides(view.azimuth);
  const scene = { floor: floor.map(([u, v]) => at(u, v, 0).slice(0, 2)), grid: [], texts: [], line: null, boxes: [] };
  for (let v = gridV; gridV > 0 && v <= sizeV; v += gridV) {
    scene.grid.push([...at(0, v, 0).slice(0, 2), ...at(sizeU, v, 0).slice(0, 2)]);
  }
  for (const { at: position, text } of ticksU) { // along the edge of u that is nearer
    const [x, y] = at(position, sides.plusV ? sizeV : 0, 0);
    scene.texts.push({ x, y: y + 12, text, anchor: "center" });
  }
  for (const { at: position, text } of ticksV) { // along the edge of v that is nearer
    const right = sides.plusU;
    const [x, y] = at(right ? sizeU : 0, position, 0);
    scene.texts.push({ x: x + (right ? 6 : -6), y: y + 3, text, anchor: right ? "left" : "right" });
  }
  if (lineV) {
    const [x1, y1] = at(0, lineV.at, 0);
    const [x2, y2] = at(sizeU, lineV.at, 0);
    scene.line = { x1, y1, x2, y2, label: lineV.label };
  }
  const withDepth = columns.map((c) => ({ c, depth: at(c.u + 0.5, c.v + 0.5, 0)[2] })).sort((p, q) => p.depth - q.depth);
  for (const { c: { u, v, value, hue = 200, shift = 0, opacity = 1, title = "" } } of withDepth) {
    const top = value * unitHeight;
    const p = (du, dv, h) => at(u + du, v + dv, h).slice(0, 2);
    const faces = [];
    // a tower is one block, or a stack of blocks of blockSize each (the top one may be shorter), so the number can be counted
    const blocks = blockSize > 0 ? Math.max(1, Math.ceil(value / blockSize - 1e-9)) : 1;
    for (let k = 0; k < blocks; k++) {
      const low = blockSize > 0 ? k * blockSize * unitHeight : 0;
      const high = blockSize > 0 ? Math.min(top, (k + 1) * blockSize * unitHeight) : top;
      if (sides.plusU) faces.push({ points: [p(1, 0, low), p(1, 1, low), p(1, 1, high), p(1, 0, high)], light: 34 + shift });
      if (sides.minusU) faces.push({ points: [p(0, 0, low), p(0, 1, low), p(0, 1, high), p(0, 0, high)], light: 34 + shift });
      if (sides.plusV) faces.push({ points: [p(0, 1, low), p(1, 1, low), p(1, 1, high), p(0, 1, high)], light: 30 + shift });
      if (sides.minusV) faces.push({ points: [p(0, 0, low), p(1, 0, low), p(1, 0, high), p(0, 0, high)], light: 30 + shift });
    }
    faces.push({ points: [p(0, 0, top), p(1, 0, top), p(1, 1, top), p(0, 1, top)], light: 52 + shift });
    scene.boxes.push({ faces, hue, opacity, title });
  }
  return scene;
}

/** Is the point inside the convex polygon? */
const inside = (points, x, y) => {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (cross !== 0) {
      if (sign !== 0 && Math.sign(cross) !== sign) {
        return false;
      }
      sign = Math.sign(cross);
    }
  }
  return true;
};

/** The title of the column at the point (the one in front when they overlap), or "". */
export function pickTitle(scene, x, y) {
  for (let i = scene.boxes.length - 1; i >= 0; i--) {
    if (scene.boxes[i].faces.some((f) => inside(f.points, x, y))) {
      return scene.boxes[i].title;
    }
  }
  return "";
}

/** The colours of the page, for the parts that are not columns. */
function pageColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return { floor: get("--panel", "#f5f5f7"), edge: get("--muted", "#777"), grid: get("--line", "#ccc"), target: get("--rejected", "#c33"), text: get("--muted", "#777") };
}

/** Paints a scene on a 2D context. */
export function paintScene(ctx, scene, colors, width, height) {
  const path = (points) => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  ctx.clearRect(0, 0, width, height);
  path(scene.floor);
  ctx.fillStyle = colors.floor;
  ctx.fill();
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = colors.grid;
  ctx.setLineDash([2, 3]);
  for (const [x1, y1, x2, y2] of scene.grid) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = "9px sans-serif";
  ctx.fillStyle = colors.text;
  for (const { x, y, text, anchor } of scene.texts) {
    ctx.textAlign = anchor;
    ctx.fillText(text, x, y);
  }
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = colors.floor;
  for (const { faces, hue, opacity } of scene.boxes) {
    for (const { points, light } of faces) {
      path(points);
      ctx.fillStyle = `hsla(${hue}, 75%, ${light}%, ${opacity})`;
      ctx.fill();
      ctx.stroke();
    }
  }
  if (scene.line) {
    const { x1, y1, x2, y2, label } = scene.line;
    ctx.strokeStyle = colors.target;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([1, 3]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.target;
    ctx.textAlign = "left";
    ctx.fillText(label, x1, y1 - 3);
  }
}

/**
 * Draws the columns into the container.
 *   columns:  [{ u, v, value, hue, shift, opacity, title }] the column stands on the cell u, v (whole numbers from 0) and is `value` high. hue is 0 to 360, shift darkens (negative) or lightens
 *             the colour, opacity 0 to 1 (all optional).
 *   sizeU, sizeV: the number of cells of the floor in each direction.
 *   maxValue: the value that is as tall as the tallest column may be (for several charts that are compared, give all the same).
 *   ticksU, ticksV: [{ at, text }] labels along the nearer edge of each axis, at is the position (0 to size).
 *   blockSize: the value of one block: a tower is then a stack of blocks of that size (the top one is shorter if the value is no whole number), 0 for one solid tower.
 *   stretchV: how many times longer a cell is along v than along u (1: square). gridV: a line across the floor every this many cells of v. lineV: { at, label } draws a dotted red line across the floor.
 *   width, height, label (for screen readers), view ({ azimuth, elevation, zoom, panX, panY } to start with).
 * Mouse: drag turns, Ctrl (Cmd on a Mac) and drag, or the right button, moves, Ctrl (Cmd) and the wheel zooms around the pointer, double click puts the view back. The same key does both. Three buttons in the corner zoom in and out and reset.
 */
export function columns3d(container, spec) {
  container.replaceChildren();
  const { width = 324, height = 340, label = "3D chart" } = spec;
  const start = { ...START_VIEW, ...(spec.view || {}) };
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    container.textContent = "This view needs canvas, which is not available here.";
    return;
  }
  const ratio = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.className = "surface";
  canvas.style.width = "100%";
  canvas.style.aspectRatio = `${width} / ${height}`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  const view = { ...start };
  let scene = null;

  const draw = () => {
    scene = buildScene({ ...spec, width, height }, view);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintScene(ctx, scene, pageColors(), width, height);
  };

  // a picture with thousands of columns is drawn at most once per frame while the mouse moves
  let waiting = false;
  const redraw = () => {
    if (typeof requestAnimationFrame !== "function") {
      draw();
    } else if (!waiting) {
      waiting = true;
      requestAnimationFrame(() => {
        waiting = false;
        draw();
      });
    }
  };
  const inPicture = (ev) => {
    const box = canvas.getBoundingClientRect();
    return [((ev.clientX - box.left) / (box.width || width)) * width, ((ev.clientY - box.top) / (box.height || height)) * height];
  };
  const sizeFactor = () => width / (canvas.getBoundingClientRect().width || width); // pixels of the screen to pixels of the picture

  /** Zooms by a factor around a point of the picture (default the middle), so that the point stays where it is. */
  const zoomBy = (factor, [sx, sy] = [width / 2, height / 2]) => {
    const zoom = Math.max(ZOOM.min, Math.min(ZOOM.max, view.zoom * factor));
    const ratioZoom = zoom / view.zoom;
    view.panX = sx - width / 2 - (sx - width / 2 - view.panX) * ratioZoom;
    view.panY = sy - height / 2 - (sy - height / 2 - view.panY) * ratioZoom;
    view.zoom = zoom;
    redraw();
  };

  let drag = null;
  canvas.addEventListener("pointerdown", (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, move: ev.ctrlKey || ev.metaKey || ev.button === 2, ...view }; // the same key moves and zooms
    canvas.setPointerCapture?.(ev.pointerId);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (drag && drag.move) {
      view.panX = drag.panX + (ev.clientX - drag.x) * sizeFactor();
      view.panY = drag.panY + (ev.clientY - drag.y) * sizeFactor();
      redraw();
    } else if (drag) {
      view.azimuth = drag.azimuth + (ev.clientX - drag.x) * 0.5;
      view.elevation = Math.max(0, Math.min(90, drag.elevation + (ev.clientY - drag.y) * 0.3)); // 0: from the side, the floor is a line. 90: from above
      redraw();
    } else if (scene) {
      canvas.title = pickTitle(scene, ...inPicture(ev));
    }
  });
  const stop = () => {
    drag = null;
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault()); // the right button moves the picture
  // the wheel only zooms with Ctrl or Cmd (a pinch on a touch pad sends Ctrl too), else it would catch the scrolling of the page
  canvas.addEventListener("wheel", (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const pixels = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 100 : 1); // a wheel that counts lines or pages is made into pixels
      zoomBy(Math.exp(-pixels * ZOOM.wheel), inPicture(ev));
    }
  }, { passive: false });
  const reset = () => {
    Object.assign(view, start);
    draw();
  };
  canvas.addEventListener("dblclick", reset);

  const tools = document.createElement("div");
  tools.className = "surface-tools";
  for (const [text, hint, action] of [["+", "Zoom in (or Ctrl and the mouse wheel, Cmd on a Mac)", () => zoomBy(ZOOM.button)], ["\u2212", "Zoom out", () => zoomBy(1 / ZOOM.button)], ["\u21BA", "Put the view back (or double click)", reset]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = hint;
    button.setAttribute("aria-label", hint);
    button.addEventListener("click", action);
    tools.append(button);
  }
  const wrap = document.createElement("div");
  wrap.className = "surface-wrap";
  wrap.append(canvas, tools);
  draw();
  container.append(wrap);
  container.__scene = () => scene; // for the tests
}

/** The columns with something in them: [{ u, v, n }], u the index of the week, v the index of the row of age. */
export function columnsOf(weeks) {
  const columns = [];
  weeks.forEach((w, u) => w.counts.forEach((n, v) => n > 0 && columns.push({ u, v, n })));
  return columns;
}

/**
 * The age maps as a 3D picture: weeks ([{ start, counts: [per row] }] from weeklyOldestAge) along one axis, the age along the other, the number of
 * add-ons as height and as colour and opacity (heatStrength). edges: the age of every row. max: the number that is as red as it gets and as tall as it may be (the same for pictures that are
 * compared). blockSize: the towers are stacks of blocks of this many add-ons (1: one block for each add-on). opacityMax: the number that is as opaque as it gets, for this picture alone (default max). colorBy: "count" (green to red by the number) or "age-weeks" (by the row, see AGE_WEEK_COLORS, the opacity stays by the number). target: { days, label } draws a dotted red line across the floor at the row of that age (days is the value in edges). rows: how the rows are named, { suffix, word, every } or with functions { label(age), describe(age), show(row) }, or with atEdges: true the labels sit on the edges between the rows, label(k) and show(k) are for the edge k.
 */
export function surfaceGraph(container, weeks, { edges, max, width = 324, height = 340, target = null, rows = { suffix: "d", word: "days", every: 20 }, colorBy = "count", stretchV = 1, opacityMax = max, blockSize = 0 } = {}) {
  if (weeks.length === 0) {
    container.textContent = "No data yet";
    return;
  }
  const t0 = weeks[0].start.getTime();
  const t1 = weeks[weeks.length - 1].start.getTime();
  const { unit, ticks } = timeTicks(t0, t1, 5);
  const row = target ? edges.indexOf(target.days) : -1;
  columns3d(container, {
    columns: columnsOf(weeks).map(({ u, v, n }) => {
      const t = heatStrength(n, opacityMax); // the opacity (and the colour by number) is relative to the busiest cell of this picture, the height to the one of all that are compared
      const color = colorBy === "age-weeks" ? ageWeekColor(v) : { hue: heatHue(t), shift: 0 }; // by the age of the row, or by the number
      return { u, v, value: n, hue: color.hue, shift: color.shift, opacity: heatOpacity(t), title: `week from ${day(weeks[u].start)}, ${rows.describe ? rows.describe(edges[v]) : `${edges[v]} ${rows.word} old`}: ${Math.round(n * 100) / 100} add-ons` };
    }),
    sizeU: weeks.length, sizeV: edges.length, maxValue: max,
    ticksU: ticks.map((d) => ({ at: weeks.length === 1 ? 0 : ((d.getTime() - t0) / (t1 - t0 || 1)) * (weeks.length - 1) + 0.5, text: tickLabel(d, unit) })),
    ticksV: (rows.atEdges
      ? [...edges, edges.length].map((_, k) => ({ at: k, text: rows.label(k) })).filter((_, k) => rows.show(k)) // on the edge between two rows: the edge after row k - 1 is at k
      : edges.map((age, v) => ({ at: v + 0.5, text: rows.label ? rows.label(age) : `${age} ${rows.suffix}` })).filter((_, v) => (rows.show ? rows.show(v) : v % rows.every === 0))),
    stretchV, blockSize, gridV: rows.gridEvery ?? 10, lineV: row >= 0 ? { at: row, label: target.label } : null,
    width, height, label: "Age of the add-ons in the review queue per week, 3D"
  });
}

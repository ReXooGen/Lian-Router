/**
 * Pure geometry for the landing constellation field.
 *
 * The canvas component owns timing, drawing, and pointer state; everything
 * here is a plain function over numbers so the seeding density, the proximity
 * threshold, and the neighbour lookup can be tested without a DOM.
 *
 * Line computation is the only part that could go quadratic. `collectStarLinks`
 * walks a uniform grid whose cell is exactly the link radius, so each star is
 * only compared against the stars in its own cell and the four adjacent cells
 * that come after it in scan order. Every unordered pair is visited exactly
 * once, which keeps a 400-star field at a few thousand distance checks per
 * frame instead of 80 000.
 */

export interface Star {
  x: number;
  /** World coordinate: grows downward through the document, not the viewport. */
  y: number;
  /** Drift velocity in CSS pixels per second. */
  vx: number;
  vy: number;
  /** 0 (dim, far) … 1 (bright, near). Drives radius, alpha, and drift speed. */
  depth: number;
  /** Twinkle offset so the field does not pulse in lockstep. */
  phase: number;
}

export interface Link {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** 1 at zero distance, 0 at the link radius. */
  readonly strength: number;
}

export interface LinkResult {
  readonly links: readonly Link[];
  /** Distance checks performed; used to prove the grid is not quadratic. */
  readonly comparisons: number;
}

export interface StarGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major star indices. */
  readonly cells: readonly (readonly number[])[];
}

/** 1080p lands at ~220 stars; a 4K viewport is capped instead of quadrupled. */
const PIXELS_PER_STAR = 9_500;
const MIN_STARS = 96;
const MAX_STARS = 420;

/** Half-cells that have not been visited yet when scanning in +x/+y order. */
const FORWARD_CELLS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function starCountFor(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return MIN_STARS;
  return clamp(Math.round((width * height) / PIXELS_PER_STAR), MIN_STARS, MAX_STARS);
}

/** Long links on a wide screen, short links on a phone; both stay readable. */
export function linkRadiusFor(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 110;
  return clamp(Math.sqrt(width * height) * 0.09, 90, 165);
}

/**
 * Seeding window, in viewport-tall bands. A band is filled while it is still
 * outside the viewport, so stars enter from the edge instead of popping in.
 */
const BAND_ABOVE = 1;
const BAND_BELOW = 1.5;

export interface SeedWindow {
  /** World y of the first seeded row. */
  readonly top: number;
  /** World y just past the last seeded row. */
  readonly bottom: number;
}

/**
 * World-space range that must stay seeded for a viewport sitting at
 * `scrollY`. The caller fills it a band at a time; because the range always
 * leads the viewport edge, the band being filled is off-screen when created.
 */
export function seedWindowFor(scrollY: number, height: number, docHeight: number): SeedWindow {
  if (!(height > 0)) return { top: 0, bottom: 0 };
  const span = Math.max(docHeight, height);
  return {
    top: Math.max(0, scrollY - height * BAND_ABOVE),
    bottom: Math.min(span, scrollY + height * (1 + BAND_BELOW)),
  };
}

/** Stars in a band of `span` world pixels, at the per-viewport density. */
export function bandStarCountFor(width: number, bandHeight: number, span: number): number {
  if (!(bandHeight > 0) || !(span > 0)) return 0;
  return Math.max(1, Math.round((starCountFor(width, bandHeight) * span) / bandHeight));
}

export function seedStars(
  count: number,
  width: number,
  height: number,
  random: () => number = Math.random,
): Star[] {
  const spanX = width > 0 ? width : 1;
  const spanY = height > 0 ? height : 1;
  const stars: Star[] = [];
  for (let index = 0; index < count; index += 1) {
    const depth = random();
    const angle = random() * Math.PI * 2;
    const speed = 3 + depth * 7;
    stars.push({
      x: random() * spanX,
      y: random() * spanY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      depth,
      phase: random() * Math.PI * 2,
    });
  }
  return stars;
}

/**
 * Indexes the stars whose world `y` falls inside `[top, top + height)`. Stars
 * outside the band are skipped rather than clamped into an edge row, so the
 * grid describes one viewport-sized slice of the document instead of the whole
 * population.
 */
export function buildStarGrid(
  stars: readonly Star[],
  cellSize: number,
  width: number,
  height: number,
  top = 0,
): StarGrid {
  const cell = Math.max(24, cellSize);
  const cols = Math.max(1, Math.ceil(Math.max(width, 1) / cell));
  const rows = Math.max(1, Math.ceil(Math.max(height, 1) / cell));
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let index = 0; index < stars.length; index += 1) {
    const star = stars[index];
    if (star === undefined) continue;
    const localY = star.y - top;
    if (localY < 0 || localY >= height) continue;
    const col = clamp(Math.floor(star.x / cell), 0, cols - 1);
    const row = Math.min(rows - 1, Math.floor(localY / cell));
    cells[row * cols + col]?.push(index);
  }
  return { cellSize: cell, cols, rows, cells };
}

export function collectStarLinks(
  stars: readonly Star[],
  grid: StarGrid,
  radius: number,
): LinkResult {
  const links: Link[] = [];
  const radiusSq = radius * radius;
  let comparisons = 0;

  const consider = (left: number, right: number): void => {
    const a = stars[left];
    const b = stars[right];
    if (a === undefined || b === undefined) return;
    comparisons += 1;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq === 0 || distanceSq > radiusSq) return;
    links.push({
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      strength: 1 - Math.sqrt(distanceSq) / radius,
    });
  };

  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const cell = grid.cells[row * grid.cols + col];
      if (cell === undefined) continue;
      for (let slot = 0; slot < cell.length; slot += 1) {
        const star = cell[slot];
        if (star === undefined) continue;
        for (let next = slot + 1; next < cell.length; next += 1) {
          const peer = cell[next];
          if (peer !== undefined) consider(star, peer);
        }
        for (const [dx, dy] of FORWARD_CELLS) {
          const nextCol = col + dx;
          const nextRow = row + dy;
          if (nextCol < 0 || nextCol >= grid.cols || nextRow < 0 || nextRow >= grid.rows) continue;
          const neighbours = grid.cells[nextRow * grid.cols + nextCol];
          if (neighbours === undefined) continue;
          for (const peer of neighbours) consider(star, peer);
        }
      }
    }
  }

  return { links, comparisons };
}

/**
 * Cursor links are O(n): one pass over the field, no grid rebuild per move.
 * The pointer is in screen space while stars are in world space, so `offsetY`
 * (the scroll position) converts each star before measuring the distance.
 */
export function collectCursorLinks(
  stars: readonly Star[],
  x: number,
  y: number,
  radius: number,
  offsetY = 0,
): readonly Link[] {
  const links: Link[] = [];
  const radiusSq = radius * radius;
  for (const star of stars) {
    const dx = star.x - x;
    const dy = star.y - offsetY - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > radiusSq) continue;
    links.push({
      ax: x,
      ay: y,
      bx: star.x,
      by: star.y - offsetY,
      strength: 1 - Math.sqrt(distanceSq) / radius,
    });
  }
  return links;
}

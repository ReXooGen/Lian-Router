import { describe, expect, test } from "bun:test";

import {
  bandStarCountFor,
  buildStarGrid,
  collectCursorLinks,
  collectStarLinks,
  linkRadiusFor,
  seedStars,
  seedWindowFor,
  starCountFor,
  type Star,
} from "./constellation-model";

/** Deterministic generator so seeding assertions do not depend on Math.random. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("constellation model", () => {
  test("scales star count with area but caps the largest displays", () => {
    expect(starCountFor(1920, 1080)).toBe(218);
    expect(starCountFor(1280, 720)).toBe(97);
    // 4K would be 873 by area alone; the cap is what keeps the fill cost sane.
    expect(starCountFor(3840, 2160)).toBe(420);
    expect(starCountFor(320, 480)).toBe(96);
    expect(starCountFor(0, 0)).toBe(96);
  });

  test("keeps the link radius readable at both ends of the size range", () => {
    expect(linkRadiusFor(390, 844)).toBe(90);
    expect(linkRadiusFor(3840, 2160)).toBe(165);
    expect(linkRadiusFor(1440, 900)).toBeCloseTo(102.46, 1);
    expect(linkRadiusFor(0, 0)).toBe(110);
  });

  test("keeps the seed window ahead of the viewport so bands are born off-screen", () => {
    // One band above and one and a half below, so the band being filled sits
    // outside the viewport at the moment it is created.
    const window = seedWindowFor(2000, 800, 6000);
    expect(window.top).toBe(1200);
    expect(window.bottom).toBe(2000 + 800 * 2.5);
    expect(seedWindowFor(0, 800, 6000).top).toBe(0);
    expect(seedWindowFor(6000 - 800, 800, 6000).bottom).toBe(6000);
  });

  test("scales a partial band by its share of the viewport", () => {
    expect(bandStarCountFor(1280, 800, 800)).toBe(starCountFor(1280, 800));
    expect(bandStarCountFor(1280, 800, 400)).toBe(Math.round(starCountFor(1280, 800) / 2));
    expect(bandStarCountFor(1280, 800, 0)).toBe(0);
  });

  test("seeds the requested number of stars inside the viewport", () => {
    const stars = seedStars(120, 800, 600, seeded(7));
    expect(stars).toHaveLength(120);
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(800);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(600);
      expect(star.depth).toBeGreaterThanOrEqual(0);
      expect(star.depth).toBeLessThanOrEqual(1);
    }
    // Depth must actually vary, or every star would twinkle and drift alike.
    expect(new Set(stars.map((star) => star.depth)).size).toBeGreaterThan(100);
  });

  test("buckets stars into grid cells by position", () => {
    const stars: Star[] = [
      { x: 10, y: 10, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 150, y: 10, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 10, y: 250, vx: 0, vy: 0, depth: 0.5, phase: 0 },
    ];
    const grid = buildStarGrid(stars, 100, 400, 400);
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(4);
    expect(grid.cells[0]).toEqual([0]);
    expect(grid.cells[1]).toEqual([1]);
    expect(grid.cells[grid.cols * 2]).toEqual([2]);
  });

  test("links close pairs once, skips distant pairs, and fades with distance", () => {
    const stars: Star[] = [
      { x: 0, y: 0, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 30, y: 0, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 500, y: 500, vx: 0, vy: 0, depth: 0.5, phase: 0 },
    ];
    const { links, comparisons } = collectStarLinks(stars, buildStarGrid(stars, 100, 600, 600), 100);
    expect(links).toHaveLength(1);
    // Only the pair sharing cell (0,0) is compared; the lone star in the far
    // cell has no forward neighbours inside the grid.
    expect(comparisons).toBe(1);
    const link = links[0];
    expect(link).toBeDefined();
    expect(link?.strength).toBeCloseTo(0.7, 5);

    const nearer: Star[] = [stars[0] as Star, { ...(stars[1] as Star), x: 10 }];
    const near = collectStarLinks(nearer, buildStarGrid(nearer, 100, 600, 600), 100).links[0];
    expect(near?.strength).toBeGreaterThan(link?.strength ?? 1);
  });

  test("visits every unordered pair at most once", () => {
    const stars = seedStars(200, 900, 700, seeded(11));
    const { links } = collectStarLinks(stars, buildStarGrid(stars, linkRadiusFor(900, 700), 900, 700), 140);
    const seen = new Set<string>();
    for (const link of links) {
      const key = [`${link.ax},${link.ay}`, `${link.bx},${link.by}`].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("rejects a pair in adjacent cells that is still beyond the radius", () => {
    // The grid cell equals the radius, so a neighbouring cell can hold a star
    // up to ~1.4r away. Without the explicit distance check these two would be
    // drawn as a line twice as long as the field allows.
    const stars: Star[] = [
      { x: 5, y: 50, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 195, y: 50, vx: 0, vy: 0, depth: 0.5, phase: 0 },
    ];
    const grid = buildStarGrid(stars, 100, 600, 600);
    expect(grid.cells[0]).toEqual([0]);
    expect(grid.cells[1]).toEqual([1]);
    const { links, comparisons } = collectStarLinks(stars, grid, 100);
    expect(comparisons).toBe(1);
    expect(links).toHaveLength(0);
  });

  test("stays sub-quadratic at the star cap", () => {
    // 4K is the worst case the cap allows: 420 stars, 87 990 possible pairs.
    const width = 3840;
    const height = 2160;
    const radius = linkRadiusFor(width, height);
    const stars = seedStars(starCountFor(width, height), width, height, seeded(3));
    expect(stars).toHaveLength(420);
    const { comparisons } = collectStarLinks(stars, buildStarGrid(stars, radius, width, height), radius);
    const everyPair = (stars.length * (stars.length - 1)) / 2;
    expect(everyPair).toBe(87990);
    // Measured: 2 666 comparisons. A regression to brute force would hit 87 990.
    expect(comparisons).toBeLessThan(6000);
  });

  test("cursor links reach the pointer within its radius and fade with distance", () => {
    const stars: Star[] = [
      { x: 100, y: 100, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 140, y: 100, vx: 0, vy: 0, depth: 0.5, phase: 0 },
      { x: 900, y: 900, vx: 0, vy: 0, depth: 0.5, phase: 0 },
    ];
    const links = collectCursorLinks(stars, 100, 100, 100);
    expect(links).toHaveLength(2);
    // A star sitting exactly under the pointer is the strongest node, not a
    // degenerate zero-length line to be skipped.
    expect(links[0]?.ax).toBe(100);
    expect(links[0]?.strength).toBeCloseTo(1, 5);
    expect(links[1]?.strength).toBeCloseTo(0.6, 5);
    expect(collectCursorLinks(stars, 500, 500, 100)).toHaveLength(0);
  });
});

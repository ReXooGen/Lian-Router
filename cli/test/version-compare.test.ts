import { describe, expect, it } from "bun:test";

import { compareVersions, normalizeVersion } from "../update/contracts";

/**
 * Comparator table. Each row is a precedence decision the update check depends
 * on: getting `2.0.0-beta.3 < 2.0.0` wrong would offer a stable user a prerelease
 * as "newer", and getting the numeric-prerelease ordering wrong would make
 * `beta.10` look older than `beta.3` and pin users to an old build.
 */
const CASES: readonly {
  readonly a: string;
  readonly b: string;
  readonly expected: -1 | 0 | 1;
  readonly why: string;
}[] = [
  { a: "1.0.0", b: "1.0.0", expected: 0, why: "identical" },
  { a: "1.0.1", b: "1.0.0", expected: 1, why: "patch bump is newer" },
  { a: "1.0.0", b: "1.0.1", expected: -1, why: "patch bump is newer, reversed" },
  { a: "1.10.0", b: "1.9.9", expected: 1, why: "segments compare numerically, not lexically" },
  { a: "v2.0.0", b: "2.0.0", expected: 0, why: "tag prefix is not significant" },
  { a: "V2.1.0", b: "2.0.9", expected: 1, why: "uppercase prefix is not significant" },
  { a: "2.0.0", b: "2.0", expected: 0, why: "missing segment counts as zero" },
  { a: "2.0", b: "2.0.1", expected: -1, why: "missing segment counts as zero, then loses" },
  { a: "2.0.0+build.5", b: "2.0.0", expected: 0, why: "build metadata is excluded from precedence" },
  { a: "2.0.0-beta.3", b: "2.0.0", expected: -1, why: "a prerelease precedes its release" },
  { a: "2.0.0", b: "2.0.0-beta.3", expected: 1, why: "a release outranks its prerelease" },
  { a: "2.0.0-beta.10", b: "2.0.0-beta.3", expected: 1, why: "numeric prerelease identifiers compare numerically" },
  { a: "2.0.0-beta.3", b: "2.0.0-beta.3.1", expected: -1, why: "fewer identifiers loses when the shared ones match" },
  { a: "2.0.0-alpha", b: "2.0.0-beta", expected: -1, why: "alphanumeric identifiers compare lexically" },
  { a: "2.0.0-beta", b: "2.0.0-beta.1", expected: -1, why: "a bare tag precedes the same tag with an identifier" },
  { a: "2.0.0-beta.1", b: "2.0.0-beta.a", expected: -1, why: "numeric identifiers sort below alphanumeric" },
  { a: "2.0.0-beta.a", b: "2.0.0-beta.1", expected: 1, why: "numeric identifiers sort below alphanumeric, reversed" },
  { a: "3.0.0", b: "2.99.99", expected: 1, why: "major dominates every lower segment" },
  { a: "", b: "1.0.0", expected: -1, why: "an unparseable empty version degrades to 0.0.0" },
  { a: "2.0.0", b: "2.0.0", expected: 0, why: "equal prerelease-free versions" },
];

describe("compareVersions", () => {
  for (const { a, b, expected, why } of CASES) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)} → ${expected} (${why})`, () => {
      expect(compareVersions(a, b)).toBe(expected);
    });
  }

  it("is antisymmetric across the whole table", () => {
    for (const { a, b, expected } of CASES) {
      // Negating 0 yields -0, which `toBe` distinguishes from 0 via Object.is.
      const mirrored: -1 | 0 | 1 = expected === 0 ? 0 : expected === 1 ? -1 : 1;
      expect(compareVersions(b, a)).toBe(mirrored);
    }
  });

  it("orders a realistic release train strictly increasing", () => {
    const train = [
      "1.9.9",
      "2.0.0-beta.1",
      "2.0.0-beta.2",
      "2.0.0-beta.10",
      "2.0.0-rc.1",
      "2.0.0",
      "2.0.1",
      "2.1.0",
      "3.0.0",
    ];
    for (let index = 1; index < train.length; index += 1) {
      const previous = train[index - 1]!;
      const current = train[index]!;
      expect(compareVersions(current, previous)).toBe(1);
    }
  });
});

describe("normalizeVersion", () => {
  it("strips whitespace and a single leading v", () => {
    expect(normalizeVersion("  v2.0.0 ")).toBe("2.0.0");
    expect(normalizeVersion("V2.0.0")).toBe("2.0.0");
    expect(normalizeVersion("2.0.0")).toBe("2.0.0");
  });
});

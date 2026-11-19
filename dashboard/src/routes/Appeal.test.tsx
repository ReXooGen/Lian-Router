import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appealRecheckRequest } from "../lib/hooks/appeal";
import type { AppealAccountRow, AppealRecheckResult } from "../lib/contracts";
import { AppealStateCell, VerdictLine } from "./Appeal";
import {
  APPEAL_RECHECK_DEFAULT,
  APPEAL_RECHECK_MAX,
  APPEAL_STATUS_OPTIONS,
  applyAppealFilter,
  beginAppealRecheck,
} from "./appeal-model";

function row(overrides: Partial<AppealAccountRow> = {}): AppealAccountRow {
  return {
    id: "acct-1",
    label: "banned@example.test",
    status: "disabled",
    lastError: "policy_blocked_banned",
    lastErrorAt: "2026-10-01T00:00:00.000Z",
    appealedAt: null,
    appealCount: 0,
    feedbackId: null,
    lastState: null,
    lastAppealError: null,
    verdict: null,
    verdictCheckedAt: null,
    ...overrides,
  };
}

function renderCell(account: AppealAccountRow): string {
  return renderToStaticMarkup(createElement(AppealStateCell, { row: account }));
}

function result(overrides: Partial<AppealRecheckResult>): AppealRecheckResult {
  return {
    accountId: "acct-1",
    label: "banned@example.test",
    verdict: "pending",
    error: null,
    ...overrides,
  };
}

describe("appeal verdict state cell", () => {
  test("an accepted verdict wins over the appeal acknowledgement", () => {
    const markup = renderCell(
      row({
        appealedAt: "2026-10-02T00:00:00.000Z",
        feedbackId: 42,
        verdict: "accepted",
        verdictCheckedAt: "2026-10-28T01:55:00.000Z",
      }),
    );

    expect(markup).toContain(">Accepted<");
    expect(markup).not.toContain(">Appealed<");
    expect(markup).toContain('class="badge badge-ok"');
    expect(markup).toContain('title="2026-10-28T01:55:00.000Z"');
  });

  test("a declined verdict wins over the appeal acknowledgement", () => {
    const markup = renderCell(
      row({
        appealedAt: "2026-10-02T00:00:00.000Z",
        feedbackId: 42,
        verdict: "declined",
        verdictCheckedAt: "2026-10-28T01:56:00.000Z",
      }),
    );

    expect(markup).toContain(">Declined<");
    expect(markup).not.toContain(">Appealed<");
    expect(markup).toContain('class="badge badge-err"');
    expect(markup).toContain('title="2026-10-28T01:56:00.000Z"');
  });

  test("an appeal without a verdict still reads Appealed", () => {
    const markup = renderCell(
      row({ appealedAt: "2026-10-02T00:00:00.000Z", feedbackId: 42, verdict: null }),
    );

    expect(markup).toContain(">Appealed<");
    expect(markup).not.toContain(">Accepted<");
    expect(markup).not.toContain(">Declined<");
  });
});

describe("appeal verdict filters", () => {
  test("offers all six states in display order", () => {
    expect(APPEAL_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      "all",
      "pending",
      "appealed",
      "accepted",
      "declined",
      "failed",
    ]);
    expect(APPEAL_STATUS_OPTIONS.map((option) => option.label)).toEqual([
      "All",
      "Belum di-appeal",
      "Sudah di-appeal",
      "Accepted",
      "Declined",
      "Gagal",
    ]);
  });

  test("applying a filter resets the table to page 1", () => {
    const statuses: string[] = [];
    const pages: number[] = [];

    applyAppealFilter("declined", {
      setStatus: (status) => statuses.push(status),
      setPage: (page) => pages.push(page),
    });

    expect(statuses).toEqual(["declined"]);
    expect(pages).toEqual([1]);
  });
});

describe("appeal re-check request", () => {
  test("clamps the batch and emits the wire body", () => {
    const bodies: Array<{ limit: number }> = [];
    beginAppealRecheck(7, (input) => bodies.push(input));
    beginAppealRecheck("12", (input) => bodies.push(input));
    beginAppealRecheck(0, (input) => bodies.push(input));
    beginAppealRecheck(500, (input) => bodies.push(input));
    beginAppealRecheck("not-a-number", (input) => bodies.push(input));

    expect(bodies).toEqual([
      { limit: 7 },
      { limit: 12 },
      { limit: 1 },
      { limit: 100 },
      { limit: APPEAL_RECHECK_DEFAULT },
    ]);
    expect(APPEAL_RECHECK_DEFAULT).toBe(20);
    expect(APPEAL_RECHECK_MAX).toBe(100);
    expect(appealRecheckRequest(bodies[0]!)).toEqual({ providerId: "cb", limit: 7 });
  });
});

describe("appeal re-check result rendering", () => {
  test("uses the verdict tone for each result", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(VerdictLine, { result: result({ verdict: "accepted" }) }),
        createElement(VerdictLine, { result: result({ verdict: "declined", error: "no ticket" }) }),
        createElement(VerdictLine, { result: result({ verdict: "pending" }) }),
      ),
    );

    expect(markup).toContain("badge badge-ok");
    expect(markup).toContain("badge badge-err");
    expect(markup).toContain("badge badge-default");
    expect(markup).toContain(">accepted<");
    expect(markup).toContain(">declined<");
    expect(markup).toContain(">pending<");
    expect(markup).toContain('title="no ticket"');
  });
});

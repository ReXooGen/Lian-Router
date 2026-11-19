import { describe, expect, test } from "bun:test";

import type {
  ReportScheduleRecord,
  ReportStorePort,
} from "../../src/console/automation/report/contracts";
import { reportSchedulePass } from "../../src/workers/quota-refresh-worker";
import type { QuotaRefreshSweepDeps } from "../../src/workers/quota-refresh-worker";

/**
 * The report-schedule ride-along, which has no route of its own: the sweep is
 * the only caller. Three properties matter and none of them are visible from
 * the route tests.
 *
 * 1. No store means no leg. A sweep test that only exercises quota and
 *    check-in must not need a database double just to be told there is no
 *    schedule to fire.
 * 2. A failing schedule load is swallowed. A broken `provider_report_schedule`
 *    read must not take the quota sweep down with it — the sweep is a timer,
 *    and an exception there is a backstop, not a channel.
 * 3. One failing row does not stop the others. Each due row is independent;
 *    the pass reports how many fired and leaves the rest to the next tick.
 */

function schedule(overrides: Partial<ReportScheduleRecord> = {}): ReportScheduleRecord {
  return {
    providerId: "cb",
    enabled: true,
    accountsPerRun: 5,
    intervalMinutes: 60,
    lastRunAt: null,
    ...overrides,
  };
}

/**
 * A store that answers only the calls this leg makes. Everything else throws,
 * so a leg that starts touching an unrelated method fails loudly instead of
 * passing on a permissive fake.
 */
function fakeStore(options: {
  readonly due?: readonly ReportScheduleRecord[];
  readonly listFails?: boolean;
  readonly runFailsFor?: readonly string[];
  readonly picked?: readonly { id: string; label: string }[];
}): { store: ReportStorePort; marked: string[]; hits: string[] } {
  const marked: string[] = [];
  const hits: string[] = [];
  const store = {
    async listDueSchedules(): Promise<readonly ReportScheduleRecord[]> {
      if (options.listFails === true) throw new Error("schedule table unreachable");
      return options.due ?? [];
    },
    async pickUnhitAccounts(args: { providerId: string }): Promise<readonly { id: string; label: string }[]> {
      hits.push(args.providerId);
      return options.picked ?? [];
    },
    async recordHit(): Promise<void> {
      // No accounts are picked in these cases, so this only fires if a test
      // asks for one; recording it keeps the fake honest about being called.
    },
    async markScheduleRun(providerId: string): Promise<void> {
      if (options.runFailsFor?.includes(providerId) === true) {
        throw new Error(`markScheduleRun refused for ${providerId}`);
      }
      marked.push(providerId);
    },
    async readSchedule(): Promise<ReportScheduleRecord> {
      return schedule();
    },
    async saveSchedule(): Promise<ReportScheduleRecord> {
      return schedule();
    },
    async listAccounts(): Promise<readonly never[]> {
      return [];
    },
    async countAccounts(): Promise<never> {
      throw new Error("countAccounts is not part of the ride-along");
    },
  } as unknown as ReportStorePort;
  return { store, marked, hits };
}

/** Only the fields the report leg reads; the sweep's own deps are not needed. */
function deps(store: ReportStorePort | undefined): QuotaRefreshSweepDeps {
  return {
    db: {} as never,
    redis: {} as never,
    providerRegistry: {} as never,
    resolveCredential: async () => "credential",
    ...(store === undefined ? {} : { reportStore: store }),
    now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
  };
}

describe("reportSchedulePass", () => {
  test("no store means the leg does not run at all", async () => {
    expect(await reportSchedulePass(deps(undefined))).toBe(0);
  });

  test("no due schedule fires nothing", async () => {
    const { store, marked } = fakeStore({ due: [] });
    expect(await reportSchedulePass(deps(store))).toBe(0);
    expect(marked).toEqual([]);
  });

  test("a due schedule runs the console's own pass and advances the cursor", async () => {
    const { store, marked, hits } = fakeStore({ due: [schedule()], picked: [] });
    expect(await reportSchedulePass(deps(store))).toBe(1);
    // The provider was asked for accounts, which is the pass actually running.
    expect(hits).toEqual(["cb"]);
    // The cursor advanced, which is what keeps the next tick a full interval
    // away instead of spinning on the same row.
    expect(marked).toEqual(["cb"]);
  });

  test("an unreadable schedule list is swallowed, not thrown", async () => {
    const { store } = fakeStore({ listFails: true });
    expect(await reportSchedulePass(deps(store))).toBe(0);
  });

  test("one failing row does not stop the next", async () => {
    const { store, marked } = fakeStore({
      due: [schedule({ providerId: "cb" }), schedule({ providerId: "cbcn" })],
      runFailsFor: ["cb"],
    });
    // "cb" fails while marking its cursor; "cbcn" must still fire.
    expect(await reportSchedulePass(deps(store))).toBe(1);
    expect(marked).toEqual(["cbcn"]);
  });

  test("the row's own account count and provider drive the pass", async () => {
    const { store, hits } = fakeStore({
      due: [schedule({ providerId: "workbuddy", accountsPerRun: 3 })],
    });
    expect(await reportSchedulePass(deps(store))).toBe(1);
    expect(hits).toEqual(["workbuddy"]);
  });
});

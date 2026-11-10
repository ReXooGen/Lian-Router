import { describe, expectTypeOf, test } from "bun:test";
import type {
  AppealAccountRow as BackendAppealAccountRow,
  AppealAccountsResponse as BackendAppealAccountsResponse,
  AppealCounts as BackendAppealCounts,
} from "../../src/console/automation/appeal/contracts";
import type {
  AppealAccountRow,
  AppealAccountsResponse,
  AppealCounts,
  AppealRecheckRequest,
  AppealRecheckResponse,
  AppealVerdict,
} from "./lib/contracts";

/**
 * The appeal verdict fields land in the dashboard mirror before the backend
 * module catches up, so the shared fields are extended rather than copied.
 * `toMatchObjectType` pins compatibility in the direction that matters: every
 * backend row/count must be a valid dashboard value.
 */
describe("dashboard/backend parity — appeal verdicts", () => {
  test("the dashboard row and counts stay compatible with the backend DTOs", () => {
    expectTypeOf<AppealAccountRow>().toExtend<BackendAppealAccountRow>();
    expectTypeOf<AppealCounts>().toExtend<BackendAppealCounts>();
    expectTypeOf<AppealAccountsResponse>().toExtend<BackendAppealAccountsResponse>();
  });

  test("the mirrored verdict and re-check DTOs keep the wire shape", () => {
    expectTypeOf<AppealVerdict>().toEqualTypeOf<"accepted" | "declined">();
    expectTypeOf<AppealAccountRow["verdict"]>().toEqualTypeOf<AppealVerdict | null>();
    expectTypeOf<AppealAccountRow["verdictCheckedAt"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AppealCounts["accepted"]>().toEqualTypeOf<number>();
    expectTypeOf<AppealCounts["declined"]>().toEqualTypeOf<number>();
    expectTypeOf<AppealRecheckRequest>().toExtend<{
      providerId: "cb";
      limit: number;
      modelId?: string;
    }>();
    expectTypeOf<{
      providerId: "cb";
      limit: number;
      modelId?: string;
    }>().toExtend<AppealRecheckRequest>();
    expectTypeOf<AppealRecheckResponse["attempted"]>().toEqualTypeOf<number>();
    expectTypeOf<AppealRecheckResponse["accepted"]>().toEqualTypeOf<number>();
    expectTypeOf<AppealRecheckResponse["declined"]>().toEqualTypeOf<number>();
    expectTypeOf<AppealRecheckResponse["pending"]>().toEqualTypeOf<number>();
  });
});

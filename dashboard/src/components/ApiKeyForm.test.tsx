import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyForm, keyCredentialFields, oneTimeSecretForMode } from "./ApiKeyForm";
import { queryKeys } from "../lib/query-keys";
import type { ApiKeyResponse } from "../lib/contracts";

const shareRecord: ApiKeyResponse = {
  id: "parent-id", label: "Team share", keyMode: "share", scopes: [], createdAt: "2026-09-01T00:00:00.000Z", secretRecoverable: false, tokensConsumed: 0,
};
function render(mode: "create" | "edit", record: ApiKeyResponse | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ApiKeyForm, {
        mode,
        record,
        busy: false,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    ),
  );
}
describe("API key mode form", () => {
  test("personal creation retains custom-key input and one-time secret affordance", () => {
    const markup = render("create", null);
    expect(markup).toContain("Personal");
    expect(markup).toContain("Share template");
    expect(markup).toContain("Custom API key value (optional)");
  });

  test("share template create/edit never renders a raw-key input", () => {
    const createMarkup = render("create", shareRecord);
    const editMarkup = render("edit", shareRecord);
    expect(createMarkup).toContain("does not authenticate requests");
    expect(editMarkup).toContain("does not authenticate requests");
    expect(createMarkup).not.toContain("Custom API key value");
    expect(editMarkup).not.toContain("Custom API key value");
  });
  test("share submission omits a raw bearer value while personal submission can carry one", () => {
    const shareBody = JSON.stringify(keyCredentialFields("share", "never-send-this", "rk_"));
    const personalBody = JSON.stringify(keyCredentialFields("personal", "rk_personal-once", "rk_"));
    expect(shareBody).not.toContain("never-send-this");
    expect(shareBody).toContain('"keyMode":"share"');
    expect(personalBody).toContain('"key":"rk_personal-once"');
  });
  test("only personal creation or conversion exposes an optional one-time secret", () => {
    expect(oneTimeSecretForMode("personal", "rk_once")).toBe("rk_once");
    expect(oneTimeSecretForMode("share", "must-not-show")).toBeNull();
    expect(oneTimeSecretForMode("personal", undefined)).toBeNull();
  });
  test("the proxy selector renders in both personal and share-template modes", () => {
    const personal = render("create", null);
    const share = render("create", shareRecord);
    for (const markup of [personal, share]) {
      expect(markup).toContain("Proxy");
      expect(markup).toContain("Default (provider routing)");
    }
    // A share template's pool is inherited by the children it mints, so the
    // copy has to say so rather than describe a single key's traffic.
    expect(share).toContain("every child key minted from it");
  });
  test("a key with no pools offers an explanation instead of an empty picker", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A resolved empty pool list is the state that used to render a dropdown
    // whose only entry was the default.
    client.setQueryData(queryKeys.network.pools, []);
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ApiKeyForm, {
          mode: "create",
          record: null,
          busy: false,
          onDone: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
    // The explanation replaces an empty dropdown, and the field still reads as
    // "Default (provider routing)" rather than blank.
    expect(markup).toContain("No active proxy pool exists in this tenant");
    expect(markup).toContain("Default (provider routing)");
  });
});

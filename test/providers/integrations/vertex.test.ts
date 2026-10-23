import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  VERTEX_MODELS,
  buildVertexAssertion,
  buildVertexUrl,
  createVertexAdapter,
  parseVertexCredential,
} from "../../../src/providers/integrations/vertex";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../src/providers/provider-registry";

const REQUEST: CanonicalRequest = {
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

const TARGET: ProviderDispatchTarget = {
  provider_id: "vertex",
  model_id: "gemini-2.5-flash",
  wire_family: "chat",
  endpoint_path: "",
  capabilities: {},
};

function contextFor(secret: string): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "vertex",
      credential_kind: "api_key",
      secret: new TextEncoder().encode(secret),
    },
    deadline: Date.now() + 5_000,
    abort_signal: new AbortController().signal,
  };
}

describe("Vertex credential parsing", () => {
  test("a bare key is an api key, not a parse failure", () => {
    expect(parseVertexCredential("AIza-something")).toEqual({ kind: "api_key", apiKey: "AIza-something" });
  });

  test("malformed JSON falls back to the raw-key path", () => {
    const parsed = parseVertexCredential('{"type":"service_account"');
    expect(parsed.kind).toBe("api_key");
    expect(parsed.apiKey).toBe('{"type":"service_account"');
  });

  test("a service-account JSON carries its project id", () => {
    const parsed = parseVertexCredential(
      JSON.stringify({
        type: "service_account",
        client_email: "svc@proj.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
        project_id: "my-project",
      }),
    );
    expect(parsed.kind).toBe("service_account");
    expect(parsed.projectId).toBe("my-project");
    expect(parsed.serviceAccount?.client_email).toBe("svc@proj.iam.gserviceaccount.com");
  });

  test("an authorized_user JSON takes its project from quota_project_id", () => {
    const parsed = parseVertexCredential(
      JSON.stringify({
        type: "authorized_user",
        client_id: "cid",
        client_secret: "csecret",
        refresh_token: "rtok",
        quota_project_id: "adc-project",
      }),
    );
    expect(parsed.kind).toBe("authorized_user");
    expect(parsed.projectId).toBe("adc-project");
  });
});

describe("Vertex URL construction", () => {
  test("a project-scoped path is used when a project is known", () => {
    const url = buildVertexUrl("https://aiplatform.googleapis.com", "gemini-2.5-flash", "generateContent", {
      projectId: "proj-1",
    });
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
    );
  });

  test("a raw key rides ?key= on the projectless path", () => {
    const url = buildVertexUrl("https://aiplatform.googleapis.com", "gemini-2.5-flash", "generateContent", {
      apiKey: "AIza-key",
    });
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=AIza-key",
    );
  });

  test("an operator-pinned location overrides the default", () => {
    const url = buildVertexUrl("https://aiplatform.googleapis.com", "gemini-4-argon", "generateContent", {
      projectId: "proj-1",
      location: "us-central1",
    });
    expect(url).toContain("/locations/us-central1/");
  });
});

describe("Vertex JWT assertion", () => {
  test("signs a three-part RS256 assertion with the Cloud Platform scope", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const assertion = buildVertexAssertion(
      { client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem },
      1_700_000_000_000,
    );
    const [header, claims, signature] = assertion.split(".");
    expect(header).toBeDefined();
    expect(claims).toBeDefined();
    expect(signature).toBeDefined();
    const decodedHeader = JSON.parse(Buffer.from(header!, "base64url").toString()) as Record<string, unknown>;
    expect(decodedHeader["alg"]).toBe("RS256");
    const decodedClaims = JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>;
    expect(decodedClaims["iss"]).toBe("svc@proj.iam.gserviceaccount.com");
    expect(decodedClaims["scope"]).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(decodedClaims["aud"]).toBe("https://oauth2.googleapis.com/token");
    expect(decodedClaims["exp"]).toBe(Math.floor(1_700_000_000_000 / 1000) + 3600);
  });
});

describe("Vertex dispatch", () => {
  test("a raw key dispatches on the projectless path with the key in the query", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createVertexAdapter({ fetch: fakeFetch });
    expect(adapter.provider_id).toBe("vertex");
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(REQUEST, TARGET, contextFor("AIza-key"))) events.push(event);

    expect(capturedUrl).toContain("/v1/publishers/google/models/gemini-2.5-flash:generateContent");
    expect(capturedUrl).toContain("key=AIza-key");
    expect(capturedHeaders["authorization"]).toBeUndefined();
    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("ok");
    expect(events.some((event) => event.type === "terminal")).toBe(true);
  });

  test("a service-account JSON mints a Bearer token and uses the project-scoped path", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const urls: string[] = [];
    let chatHeaders: Record<string, string> = {};
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      chatHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const secret = JSON.stringify({
      type: "service_account",
      client_email: "svc@proj.iam.gserviceaccount.com",
      private_key: pem,
      project_id: "proj-9",
    });
    const adapter = createVertexAdapter({ fetch: fakeFetch });
    for await (const _event of adapter.dispatch(REQUEST, TARGET, contextFor(secret))) {
      // drain
    }

    expect(urls[0]).toBe("https://oauth2.googleapis.com/token");
    expect(urls[1]).toContain("/v1/projects/proj-9/locations/global/publishers/google/models/");
    expect(chatHeaders["authorization"]).toBe("Bearer ya29.token");
  });

  test("the catalog carries every chat id and no video id", () => {
    const ids = VERTEX_MODELS.map((model) => model.modelId);
    expect(ids).toEqual([
      "gemini-4-argon",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ]);
    expect(ids.some((id) => id.startsWith("veo-"))).toBe(false);
  });
});

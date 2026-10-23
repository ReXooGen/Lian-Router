import { completeRequiredSchema } from "../../protocol/primitives";
import type { ModelDefinition } from "../provider-registry";
import { isRecord } from "../../protocol/primitives";
import { PROVIDER_COMPATIBILITY_PROFILES } from "../provider-metadata";
import { defineModel } from "../model-definition";
import type { ApiKeyProviderSpec } from "./configured-provider";
import { resolveOpenCodeVersion } from "../operations/client-versions";
import { GatewayError } from "../../transport/gateway-error";
import {
  buildOpenCodeFreeHeaders,
  buildOpenCodeHeaders,
  ensureFreeAgentRequest,
  invalidateOpenCodeSession,
} from "./opencode-fingerprint";
/**
 * OpenCode's three API-key tiers, all served from `opencode.ai`:
 *
 * - `opencodeft` (OpenCode Free): the public free endpoint. The upstream
 *   gate rejects anything that doesn't look like the real OpenCode binary
 *   with `FreeTierError` (upstream 403 "OpenCode's free tier can only be
 *   used from within OpenCode"). Account `Authorization` is withheld and
 *   replaced with the literal `Authorization: Bearer public`; the
 *   fingerprint quartet tools (bash/glob/grep/read) and `stream: true` are
 *   installed on every dispatch.
 * - `opencodezen` (OpenCode Zen): billed API-key route on `/zen/v1`.
 * - `opencodego` (OpenCode Go): billed API-key route on the separate
 *   `/zen/go/v1` base — a bundled, higher-tier model set.
 *
 * Free and Zen use the OpenCode desktop-client header fingerprint
 * (`x-opencode-*` correlation IDs, `user-agent: opencode`). Go is
 * intentionally API-key-only.
 */
const ZEN_PATH_PREFIX = "/zen/v1";
const GO_PATH_PREFIX = "/zen/go/v1";

async function opencodeDesktopHeaders(context: unknown): Promise<Record<string, string>> {
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveOpenCodeVersion();
  return buildOpenCodeHeaders(undefined, context as never);
}

/**
 * OpenCode Free gate requires the full desktop fingerprint PLUS the literal
 * `Authorization: Bearer public` on every dispatch — the upstream rejects
 * anything else with "OpenCode's free tier can only be used from within
 * OpenCode" (upstream 403). The accompanying request-side mutation
 * (`ensureFreeAgentRequest`) enforces the lowercase quartet fingerprint tools
 * and forces streaming.
 */
async function opencodeFreeHeaders(context: unknown): Promise<Record<string, string>> {
  await resolveOpenCodeVersion();
  return buildOpenCodeFreeHeaders(context as never);
}

/**
 * Retire the handle upstream says is spent.
 *
 * The free tier's allowance is keyed on the source address, so this does not
 * restore quota: the same egress retried with a new `x-opencode-session` is
 * still refused. What actually lifts a spent allowance is the pool cooldown
 * this error triggers upstream of the adapter, which steers the next request
 * to a different exit. Retiring the handle is separate hygiene — a session the
 * upstream has just declared spent should not be handed to the next
 * conversation.
 *
 * Gated on the structured flag the failure classifier sets from the upstream
 * body: a bare 429 is a request window the same handle may pass shortly, and a
 * 5xx is not about this handle at all — rotating on either would throw away a
 * healthy conversation's affinity for nothing.
 */
function retireSpentFreeSession(error: unknown, context: unknown): void {
  if (!(error instanceof GatewayError)) return;
  if (error.details.freeTierAllowanceExhausted !== true) return;
  invalidateOpenCodeSession(context as never);
}


function completeOpenCodeToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const functionValue = tool.function;
    if (isRecord(functionValue) && "parameters" in functionValue) {
      return {
        ...tool,
        function: { ...functionValue, parameters: completeRequiredSchema(functionValue.parameters) },
      };
    }
    if ("parameters" in tool) return { ...tool, parameters: completeRequiredSchema(tool.parameters) };
    return tool;
  });
}

function opencodeSpec(providerId: "opencodeft" | "opencodezen" | "opencodego"): ApiKeyProviderSpec {
  // The free tier is the one that lists a Claude-format model (`union-alpha`),
  // served on `/zen/v1/messages`. That path is a real route on the shared Zen
  // base (it answers the free-tier gate rather than 404), but only the free
  // tier's catalog names a model for it, so only the free spec declares it.
  const servesMessages = providerId === "opencodeft";
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: {
      ...PROVIDER_COMPATIBILITY_PROFILES[providerId]?.endpoint_paths_by_wire_family,
      ...(servesMessages ? { messages: `${ZEN_PATH_PREFIX}/messages` } : {}),
    },
    supported_wire_families: servesMessages
      ? ["chat", "responses", "messages"]
      : ["chat", "responses"],
    promptCache: false,
    extra_headers: { accept: "application/json" },
    // Go is API-key-only: it never receives the desktop fingerprint; Free
    // uses the free-tier header set (Bearer public + Accept SSE); Zen uses the
    // billed-account desktop fingerprint.
    ...(providerId === "opencodego"
      ? {}
      : providerId === "opencodeft"
        ? { buildExtraHeaders: opencodeFreeHeaders }
        : { buildExtraHeaders: opencodeDesktopHeaders }),
    // OpenCode Free is a genuinely public endpoint whose only accepted
    // Authorization is the hard-coded `Bearer public` injected above. Console
    // account creation still allows any credentialKind for it, so the
    // "never forward" contract is enforced here rather than trusting account
    // config. The request-side `ensureFreeAgentRequest` installs the
    // lowercase quartet fingerprint tools (bash/glob/grep/read) that the
    // upstream gate requires on every free dispatch.
    ...(providerId === "opencodeft"
      ? {
          credential_forwarding: "never" as const,
          prepareRequest: ensureFreeAgentRequest,
          onUpstreamFailure: retireSpentFreeSession,
        }
      : {}),
    prePayload: (payload, request, candidate) => {
      completeOpenCodeToolSchemas(payload);
      clampOpenCodeOutputBudget(payload, candidate.model_id);
      if (candidate.wire_family === "responses") {
        payload.store = false;
      }
      if (candidate.wire_family === "chat" && request.stream) {
        payload.stream_options = {
          ...(typeof payload.stream_options === "object" && payload.stream_options !== null
            ? (payload.stream_options as Record<string, unknown>)
            : {}),
          include_usage: true,
        };
      }
    },
  };
}
/**
 * Output budget by model id, resolved lazily from this file's own catalogs
 * (`out:` rows and the models.dev fallback behind `defineModel`). Clients
 * sized for a 1M-window sibling (e.g. the MiMo 1M context on other tiers) send
 * `max_tokens: 1000000`; the shared Zen upstream then rejects
 * `input + max_tokens > context` with a 400 before generating a single token.
 * The clamp mirrors the Kimi adapter's `Math.min` policy: a caller ceiling
 * above the catalog's output limit is a client-side guess, not a contract.
 * Lazy init: the `*_SPEC` singletons are constructed before the catalogs in
 * module order, so an eager map would hit a TDZ reference.
 */
let outputLimitsByModel: ReadonlyMap<string, number> | undefined;
function openCodeOutputLimits(): ReadonlyMap<string, number> {
  outputLimitsByModel ??= new Map(
    [...OPENCODE_FREE_MODELS, ...OPENCODE_ZEN_MODELS, ...OPENCODE_GO_MODELS]
      .filter((model): model is ModelDefinition & { outputLimit: number } => model.outputLimit !== null)
      .map((model) => [model.modelId, model.outputLimit] as const),
  );
  return outputLimitsByModel;
}

function clampOpenCodeOutputBudget(payload: Record<string, unknown>, modelId: string): void {
  const limit = openCodeOutputLimits().get(modelId.toLowerCase());
  if (limit === undefined) return;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
    const value = payload[key];
    if (typeof value === "number" && value > limit) payload[key] = limit;
  }
}

/** OpenCode Free — unauthenticated public route. No credential is ever forwarded. */
export const OPENCODE_FREE_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodeft");
/** OpenCode Zen — billed API-key route on `/zen/v1`. */
export const OPENCODE_ZEN_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodezen");
/** OpenCode Go — billed API-key route on the separate `/zen/go/v1` base. */
export const OPENCODE_GO_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodego");

// Limits and pricing resolve from the committed models.dev snapshot
// (`base-models.json`) via `providerId`; the snapshot is keyed per provider, so
// passing it is what makes the lookup answer with OpenCode's own entry instead
// of a same-named model from another reseller. Only rows the snapshot predates
// (a model newer than the snapshot) keep explicit `ctx`/`out`.
const sharedZenChat: readonly ModelDefinition[] = [
  defineModel({ id: "big-pickle", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  // Live on the shared `/zen/v1` base for both tiers. Not in the snapshot yet,
  // so its limits stay explicit (authoritative models.dev row: 200k/32k, free)
  // and `free` pins the cost rather than leaving it unresolved. Tenant aliases
  // and fallback combos target this id by name, so dropping the row silently
  // breaks them: `seedBundledModels` prunes any `builtin` row the catalog no
  // longer declares, and routing then reports `model_not_found` for the alias.
  // The row stays even when the address's free allowance is exhausted: the
  // allowance is per source address on a rolling daily window, so the same row
  // serves again from another egress pool or after the reset, and the 429 is
  // reported as the gate it is (`classifyRateLimitScope` → `network`).
  defineModel({ id: "mimo-v2.6-flash-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 200000, out: 32000, vision: true, document: true, audio: true, reasoning: true, free: true }),
  // The free tier rotates: upstream deprecates old ids and serves new ones
  // under the same `/zen/v1` base (verified live against `GET /zen/v1/models`
  // with `Authorization: Bearer public`, which needs no attestation). Rows the
  // current snapshot predates keep explicit limits from models.dev's own
  // current data; snapshot-covered rows stay snapshot-driven.
  // beam-free: 1M/128k, text-only MoE reasoning.
  defineModel({ id: "beam-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 1048576, out: 131072, reasoning: true, free: true }),
  // longcat-2.5-preview-free: 1M/128k, text+image.
  defineModel({ id: "longcat-2.5-preview-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 1000000, out: 131072, vision: true, reasoning: true, free: true }),
  // deepseek-v4.1-flash-free / glm-5.3-flash-free: the `-free` ids are the free
  // tier's current serving of the V4.1-Flash / GLM-5.3-Flash families (200k/32k
  // each, per models.dev). The bare `deepseek-v4.1-flash` / `glm-5.3-flash` ids
  // remain Zen/paid-tier rows on the same base and are NOT served to the free
  // tier - dispatching them from this catalog answered `502 Unexpected server
  // error` upstream, a dead request indistinguishable from an outage.
  defineModel({ id: "deepseek-v4.1-flash-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 200000, out: 32000, vision: true, reasoning: true, free: true }),
  defineModel({ id: "glm-5.3-flash-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 200000, out: 32000, vision: true, document: true, audio: true, reasoning: true, free: true }),
  // nemotron-3.5-super-vl-free: 1M/128k, text+image (snapshot predates it).
  defineModel({ id: "nemotron-3.5-super-vl-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 1048576, out: 131072, vision: true, reasoning: true, free: true }),
  // nemotron-3.5-lightning-free: 256k/256k, text-only (snapshot-covered).
  defineModel({ id: "nemotron-3.5-lightning-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, reasoning: true, free: true }),
  // minimax-m3.1-flash-free: 1M/512k, text+image+video (snapshot-covered).
  defineModel({ id: "minimax-m3.1-flash-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true, free: true }),
];

const MUSE_SPARK_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const OPENCODE_FREE_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  // 1M/128k, text-only; snapshot-covered (`opencode` row).
  defineModel({ id: "nemotron-3-ultra-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.3-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  // Claude-format model: the published roster marks it `targetFormat: claude`,
  // and `/zen/v1/messages` is a live route on this base (it answers the
  // free-tier gate, where an unknown path answers 404).
  defineModel({ id: "union-alpha", providerId: "opencode", wireFamily: "messages", endpoint: `${ZEN_PATH_PREFIX}/messages`, reasoning: true }),
];

export const OPENCODE_ZEN_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  // Paid-tier serving of the same families: snapshot-covered rows, no explicit
  // limits. The free tier must not claim these ids - see the note on
  // `deepseek-v4.1-flash-free` above.
  defineModel({ id: "deepseek-v4.1-flash", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  defineModel({ id: "glm-5.3-flash", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "muse-spark-1.2", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  // Absent from the snapshot: keep the declared limits rather than falling back
  // to the generic default.
  defineModel({ id: "muse-spark-1.2-contributor", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, ctx: 1048576, out: 131072, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.3", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "ling-3.0-flash-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
];

export const OPENCODE_GO_MODELS: readonly ModelDefinition[] = [
  // Absent from the snapshot under `opencode-go`: keep the declared limits.
  defineModel({ id: "muse-spark-1.2", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, ctx: 1048576, out: 131072, vision: true, reasoning: true }),
  defineModel({ id: "muse-spark-1.2-contributor", providerId: "opencode-go", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, vision: true, reasoning: true }),
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode-go", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, vision: true, reasoning: true }),
  defineModel({ id: "grok-4.5", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "kimi-k3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.7-code", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "mimo-v2.5-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "qwen3.7-max", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "minimax-m3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "hy3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
];


/**
 * ZCode start-plan lane — Anthropic Messages wire.
 *
 * ZCode's desktop client talks to `https://zcode.z.ai` over a plan lane
 * authenticated by the plan JWT its login flow mints, metered against the
 * grants the account already owns rather than per token. Two properties of that
 * lane are wire contracts, not preferences:
 *
 *  - The `system` field is inspected as content. Exactly three blocks are
 *    required: the CLI prefix verbatim, the canonical stable text (byte-exact,
 *    leading newline included) and then the caller's own prompt. Any other
 *    shape is refused with `405 {"code":3012}` regardless of headers.
 *  - No signing headers (`x-client-sig`, `x-client-pow`, `x-app-id`). A signed
 *    request authenticates but lands on the paid lane and answers
 *    `429 {"code":1113}` even when the plan balance is full.
 *
 * The body is reshaped in `prePayload`, after the Messages encoder has run and
 * after it hoisted `system`/`developer` turns out of `messages[]`. Reshaping
 * earlier would miss the hoisted text; reshaping here guarantees the caller's
 * own words can only ever land in block 3.
 */
import { createHash } from "node:crypto";
import type { ApiKeyProviderSpec } from "../configured-provider";
import { defineModel, type ModelDefinition } from "../../model-definition";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { zcodePlanToken } from "./zcode-oauth";
import {
  ZCODE_ANTHROPIC_BETA,
  ZCODE_ANTHROPIC_VERSION,
  ZCODE_APP_VERSION,
  ZCODE_CLI_PREFIX,
  ZCODE_SDK_USER_AGENT,
  ZCODE_STABLE_PREFIX,
} from "./identity";

const ZCODE_PROVIDER_ID = "zcode" as const;

/** Plan-lane inference path, in front of the `https://zcode.z.ai` origin. */
export const ZCODE_MESSAGES_PATH = "/api/v1/zcode-plan/anthropic/v1/messages";

/** One Anthropic system block as the plan lane expects it. */
interface ZcodeSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

/**
 * Builds the three-block system array from the caller's own system text.
 *
 * Block 3 keeps a leading blank line when the caller supplied text, matching
 * the captured client. An empty caller prompt still yields an empty third
 * block rather than a dropped one: the gateway counts blocks, so a two-block
 * body is the 3012 shape.
 */
export function buildZcodeSystem(clientSystem: string): readonly ZcodeSystemBlock[] {
  const trimmed = clientSystem.trim();
  return [
    { type: "text", text: ZCODE_CLI_PREFIX },
    { type: "text", text: ZCODE_STABLE_PREFIX, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: trimmed.length === 0 ? "" : `\n\n${trimmed}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * Collects the caller's own system text out of an already-encoded Messages
 * body. The encoder emits `system` as an array of blocks; a plain string is
 * accepted too because the shape is the upstream's, not ours.
 */
function payloadSystemText(system: unknown): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  const texts: string[] = [];
  for (const block of system) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    const text = record["text"];
    if (typeof text === "string" && text.trim().length > 0) texts.push(text);
  }
  return texts.join("\n\n").trim();
}

/**
 * Derives the billing device UUID from the plan JWT.
 *
 * The account's device id is created at login and bound to the account, so it
 * must be stable across processes: a fresh UUID per process presents every
 * restart as a new device. Deriving it from the credential keeps it stable and
 * per-account without a second store. The value only has to parse as a UUID;
 * nothing reads its contents back.
 */
export function zcodeDeviceId(jwt: string): string {
  const digest = createHash("sha256").update("zcode-device\0").update(jwt).digest("hex");
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 20)}${digest.slice(20, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Derives the per-conversation session id the gateway meters against.
 *
 * Retries and follow-up turns of one conversation must reuse the id or the
 * gateway treats each turn as a separate session. It is keyed on the
 * conversation identity the canonical request already carries, falling back to
 * the first text turn so a client that sends no session id still gets affinity.
 */
export function zcodeSessionId(request: CanonicalRequest): string {
  const firstText = request.messages[0]?.content.find((part) => part.kind === "text")?.text ?? "";
  const key =
    request.session_id ?? request.conversation_id ?? request.thread_id ?? firstText;
  const digest = createHash("sha256").update("zcode-session\0").update(key).digest("hex");
  return `session_${digest.slice(0, 32)}`;
}

/** Printable-ASCII gate: the gateway rejects non-ASCII header values outright. */
function printable(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

function osCategory(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/**
 * The client identity face the plan lane expects on inference calls.
 *
 * No `x-device-mid` here: the LLM face does not carry one, and adding it moves
 * the request onto the billing face. `user-agent` comes from the captured SDK
 * string so the request matches the client version the identity asset was taken
 * from.
 */
function zcodeInferenceHeaders(request: CanonicalRequest | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "http-referer": "https://zcode.z.ai",
    "user-agent": printable(ZCODE_SDK_USER_AGENT) ?? `ZCode/${ZCODE_APP_VERSION}`,
    "x-title": "Z Code@electron",
    "x-release-channel": "production",
    "x-zcode-agent": "glm",
    "x-zcode-app-version": ZCODE_APP_VERSION,
    "x-zcode-session-type": "main",
    "x-zcode-query-source": "main_turn",
    "x-platform": `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    "x-os-category": osCategory(),
    "anthropic-version": ZCODE_ANTHROPIC_VERSION,
    "anthropic-beta": ZCODE_ANTHROPIC_BETA,
  };
  if (request !== undefined) headers["x-session-id"] = zcodeSessionId(request);
  // Locale and timezone come from the runtime's own resolution rather than
  // `LANG`/`TZ`: those are shell conventions (`C.UTF-8` is not a language tag),
  // while the gateway only needs a printable value that looks like the client's.
  const locale = printable(Intl.DateTimeFormat().resolvedOptions().locale);
  if (locale !== undefined) headers["x-client-language"] = locale;
  const timezone = printable(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (timezone !== undefined) headers["x-client-timezone"] = timezone;
  return headers;
}

/**
 * ZCode plan lane.
 *
 * `credential_forwarding: "never"` withholds the default `Authorization` so the
 * adapter emits exactly one bearer — the plan JWT — instead of two competing
 * ones when the stored credential is a JSON envelope. `streaming_usage_mode:
 * "none"` matters on this wire: the shared factory otherwise injects an
 * OpenAI-shaped `stream_options` into an Anthropic body, which the plan lane
 * rejects.
 */
export const ZCODE_SPEC: ApiKeyProviderSpec = {
  provider_id: ZCODE_PROVIDER_ID,
  supported_wire_families: ["messages"],
  endpoint_paths_by_wire_family: { messages: ZCODE_MESSAGES_PATH },
  credential_forwarding: "never",
  streaming_usage_mode: "none",
  buildExtraHeaders: (context, request) => {
    const raw = context.credential.secret
      ? new TextDecoder().decode(context.credential.secret).trim()
      : "";
    if (raw.length === 0) return {};
    // An OAuth login stores `{planToken, accessToken, user}`; a pasted
    // credential is the bare JWT. Both reach the lane as one bearer.
    const jwt = zcodePlanToken(raw);
    if (jwt.length === 0) return {};
    return { ...zcodeInferenceHeaders(request), authorization: `Bearer ${jwt}` };
  },
  prePayload: (payload) => {
    payload["system"] = buildZcodeSystem(payloadSystemText(payload["system"]));
    // `metadata.user_id` is deliberately not synthesized here. The desktop
    // client fills it with `{device_id, account_uuid, session_id}` and the
    // gateway uses it for attribution only — it is not part of the 3012 gate,
    // which reads the `system` shape and the absence of signing headers. The
    // payload hook has no access to the credential, so fabricating the device
    // id would need a stateful channel between the header and body phases; that
    // machinery is not worth adding for a field whose necessity is unverified.
  },
};

/**
 * The two GLM models the start-plan grants name.
 *
 * Limits and vision are declared here rather than inherited. The base catalog
 * keys these ids under `zai`, so a `zcode` lookup missed and every row fell to
 * the shared defaults (200k context, 64k output, no image input) — the plan
 * lane actually serves 1M context / 128k output, which is what the desktop
 * client shows for the same account.
 *
 * Vision is per row, not per family: sent the same 512×512 image, `glm-5.3-flash`
 * described the shapes correctly while `glm-5.3` reported seeing a blank page.
 * The base catalog agrees (`zai/glm-5.3` lists text-only input, the flash row
 * lists images), so only the flash row claims it. Claiming it on both would
 * strip the image at preflight for one model and hand it to a model that
 * cannot read it on the other.
 */
export const ZCODE_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "glm-5.3",
    providerId: ZCODE_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_MESSAGES_PATH,
    ctx: 1_000_000,
    out: 131_072,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "glm-5.3-flash",
    providerId: ZCODE_PROVIDER_ID,
    wireFamily: "messages",
    endpoint: ZCODE_MESSAGES_PATH,
    ctx: 1_000_000,
    out: 131_072,
    vision: true,
    reasoning: true,
    toolCall: true,
  }),
];

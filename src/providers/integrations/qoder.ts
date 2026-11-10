// Factory-blocked (Phase C4): PAT-to-jobToken session handshake, COSY
// AES/RSA request signing, alphabet-scrambled binary body, enveloped SSE
// frames — session/crypto protocol outside factory reach; stays bespoke.
//
// The request body below mirrors the official `qodercli` agent request field
// for field, because the upstream agent gateway fingerprints it: a body that
// drops `system`, `business`, or `tools` is answered with prose ("I don't have
// access to a get_weather tool") instead of streamed `tool_calls` deltas, and
// the reasoning/context switches it does accept are per-model enums rather
// than one global ladder. Every value here was read off a live capture, not
// inferred from the field names.
import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { classifyRateLimitScope, extractUpstreamMessage, mapUpstreamHttpError, statusToGatewayErrorCode } from "../../transport/failure-policy";
import { GatewayError } from "../../transport/gateway-error";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalStopReason,
  ContentPart,
  ReasoningEffort,
} from "../../transport/canonical-model";
import { toolCallParts, toolResultParts } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { usageFromProvider, readReasoningText } from "../usage";
import {
  readCredentialSecret,
  type ProviderDispatchTarget,
  type ModelDefinition,
  type ProviderAdapter,
  type ProviderDispatchContext,
} from "../provider-registry";
import { defineModel } from "../model-definition";
import { getQoderVersion, resolveQoderVersion } from "../operations/client-versions";
import { createUpstreamDeadlineLifecycle, abortFailure } from "../operations/upstream-deadline";
import { resolveInboundSessionId } from "../operations/session-resolution";
import { QODER_SYSTEM_PROMPT } from "./qoder-system-prompt";

export interface QoderModeProfile {
  readonly chatUrl: string;
  readonly businessProduct: string;
  readonly businessType: string;
  readonly cosyScene: string;
  readonly mirrorTopLevelSystem: boolean;
  readonly sendBusinessHeaders: boolean;
  readonly sendModelSourceHeaders: boolean;
  readonly emptyAliyunUserType: boolean;
}

export type QoderRegion = "intl" | "cn";

export const MODERN_PROFILE: QoderModeProfile = {
  chatUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
  businessProduct: "cli",
  businessType: "agent",
  cosyScene: "assistant",
  mirrorTopLevelSystem: true,
  sendBusinessHeaders: true,
  sendModelSourceHeaders: true,
  emptyAliyunUserType: true,
};

/**
 * Qoder CN. Both sites run the same path shapes on different hosts and bill
 * different SKUs behind the same model keys, so the region selects the host
 * set and the catalog together — never one without the other. CN serves every
 * token kind (PAT-exchanged job tokens included) from its single gateway host,
 * so it has no `api2`-style split.
 */
export const CN_PROFILE: QoderModeProfile = {
  ...MODERN_PROFILE,
  chatUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
};

export const QODER_REGION_PROFILES: Readonly<Record<QoderRegion, QoderModeProfile>> = {
  intl: MODERN_PROFILE,
  cn: CN_PROFILE,
};

/** Job-token exchange host per region; the CN gateway doubles as its center. */
const QODER_JOB_TOKEN_URLS: Readonly<Record<QoderRegion, string>> = {
  intl: "https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1",
  cn: "https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1",
};

const QODER_PROVIDER_ID = "qoder" as const;
export const QODER_CN_PROVIDER_ID = "qoder-cn" as const;

/**
 * One row of Qoder's live `GET /algo/api/v2/model/list` chat catalog.
 *
 * `efforts` is the model's own accepted ladder and `defaultEffort` the tier it
 * applies when the client sends nothing. They are per model, not a shared
 * scale: Qwen3.8 stops at `xhigh` and answers a generic `max` by silently
 * dropping it, while DeepSeek's ladder is `low`/`high`/`max` with no
 * `medium`/`xhigh`. `canDisable` is the presence of a `thinking_config.disabled`
 * arm — a model without one keeps thinking on and can only be re-levelled.
 */
export interface QoderModelConfig {
  readonly id: string;
  readonly displayName: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort;
  readonly canDisable: boolean;
  /** Publishes a `fast` function switch; the native client leaves it on. */
  readonly fastSwitch?: boolean;
  /** Priced at zero by the upstream (`is_free`), so billing must not invent a rate. */
  readonly free?: boolean;
}

/** Per-region model catalog: the same key names describe different SKUs. */
export type QoderModelConfigMap = Record<string, QoderModelConfig>;

/** Ladder positions, low → high. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const QODER_MODEL_CONFIGS: Record<string, QoderModelConfig> = {
  auto: { id: "auto", displayName: "Auto", maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  ultimate: { id: "ultimate", displayName: "Ultimate", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", canDisable: false },
  fast: { id: "fast", displayName: "Fast", maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  efficient: { id: "efficient", displayName: "Efficient", maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  smodel: { id: "smodel", displayName: "Sonus", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", canDisable: false },
  cmodel: { id: "cmodel", displayName: "Cantus", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", canDisable: false },
  qmodel_38max: { id: "qmodel_38max", displayName: "Qwen3.8-Max", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "medium", canDisable: true },
  qfmodel: { id: "qfmodel", displayName: "Qwen3.8-Flash", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "medium", canDisable: true, free: true },
  kmodel_latest: { id: "kmodel_latest", displayName: "Kimi-K3.1-Pro", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  kmodel: { id: "kmodel", displayName: "Kimi-K2.8-Preview", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false, fastSwitch: true },
  gmodel: { id: "gmodel", displayName: "GLM-5.3", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  gfmodel: { id: "gfmodel", displayName: "GLM-5.3-Flash", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["high", "max"], defaultEffort: "max", canDisable: false },
  dmodel: { id: "dmodel", displayName: "DeepSeek-V4-Pro", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["high", "max"], defaultEffort: "max", canDisable: true },
  dfmodel: { id: "dfmodel", displayName: "DeepSeek-Flash", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: true },
  mmodel: { id: "mmodel", displayName: "MiniMax-M3.1-Flash", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
};

/** Default reservation when the caller names no output limit (native default). */
const QODER_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Qoder CN catalog. The tier keys are shared with intl, but the frontier keys
 * are not interchangeable: CN serves its own Qwen/GLM generation behind
 * `qmodel_38max`/`qfmodel`/`gmodel`/`gfmodel` and does not carry intl's
 * `qmodel_preview` or `gm51model`. Sending an intl key to the CN gateway
 * downgrades the model silently, so the two catalogs stay separate.
 */
export const QODER_CN_MODEL_CONFIGS: QoderModelConfigMap = {
  ultimate: { id: "ultimate", displayName: "Ultimate", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", canDisable: false },
  auto: { id: "auto", displayName: "Auto", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  performance: { id: "performance", displayName: "Performance", maxInputTokens: 272_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  efficient: { id: "efficient", displayName: "Efficient", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  lite: { id: "lite", displayName: "Lite", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: false, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", canDisable: false },
  qmodel_38max: { id: "qmodel_38max", displayName: "Qwen3.8-Max", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "medium", "xhigh"], defaultEffort: "medium", canDisable: true },
  qmodel_latest: { id: "qmodel_latest", displayName: "Qwen3.7-Max", maxInputTokens: 1_000_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  qmodel: { id: "qmodel", displayName: "Qwen3.7-Plus", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  qfmodel: { id: "qfmodel", displayName: "Qwen3.8-Flash", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  kmodel_latest: { id: "kmodel_latest", displayName: "Kimi-K3", maxInputTokens: 256_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  kmodel: { id: "kmodel", displayName: "Kimi-K2.7-Code", maxInputTokens: 256_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  gmodel: { id: "gmodel", displayName: "GLM-5.3", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  gfmodel: { id: "gfmodel", displayName: "GLM-5.3-Flash", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
  dmodel: { id: "dmodel", displayName: "DeepSeek-V4-Pro", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  dfmodel: { id: "dfmodel", displayName: "DeepSeek-V4-Flash", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: true, efforts: ["low", "high", "max"], defaultEffort: "high", canDisable: false },
  mmodel: { id: "mmodel", displayName: "MiniMax-M3", maxInputTokens: 180_000, maxOutputTokens: 32_000, vision: true, reasoning: false, efforts: [], defaultEffort: "none", canDisable: false },
};

const QODER_APPCODE = "cosy";
const QODER_SIG_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const QODER_STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** Upstream code meaning "the model is queued", not "this account is broken". */
const QODER_QUEUE_CODE = "10605";
/**
 * Total time one dispatch may spend waiting out a model queue.
 *
 * The native client waits up to ten minutes; a gateway slot cannot, so the
 * budget is bounded by whichever runs out first — this constant or the
 * request's own deadline. Below that, the queue verdict is surfaced as
 * capacity rather than silently retried.
 */
const QODER_QUEUE_RETRY_BUDGET_MS = 90_000;
/** Floor before the first retry when the envelope names no delay. */
const QODER_QUEUE_DEFAULT_DELAY_MS = 30_000;
/** Leave room to actually read the retried response before the deadline. */
const QODER_QUEUE_DEADLINE_MARGIN_MS = 15_000;

export interface QoderAuth {
  userId: string;
  userName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  machineId: string;
}

function qoderMd5(value: string | Uint8Array): string {
  return createHash("md5").update(value).digest("hex");
}

function qoderPathSignature(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith("/algo") ? path.slice(5) : path;
}

/**
 * The device identity presented with this PAT, stable for the life of the
 * credential.
 *
 * Qoder binds a PAT to the machine that first exchanged it, and its
 * `RESOURCE_LIMIT` throttle keys on device count: many "devices" sharing one
 * PAT reads as credential sharing and is answered with `10605` on every model.
 * A random id per process therefore breaks a healthy account after each
 * restart, so the id is derived from the PAT itself — same PAT, same device,
 * forever — which is also what a real installation does by persisting its
 * machine id beside its credentials.
 *
 * Derived through SHA-256 and shaped as a UUID (version 5 layout) because that
 * is the format the upstream expects and validates.
 */
function qoderMachineIdFromPat(pat: string): string {
  const digest = createHash("sha256").update("qoder-machine\0").update(pat).digest("hex");
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}8${digest.slice(17, 20)}${digest.slice(20, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function qoderStaticHeaders(machineId: string, version = getQoderVersion()): Record<string, string> {
  const date = new Date().toUTCString();
  return {
    "cosy-machinetoken": machineId,
    "cosy-machinetype": "5",
    "cosy-machineid": machineId,
    "cosy-clienttype": "5",
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date,
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${date}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

function transformQoderBody(plaintext: string): Uint8Array {
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered = base64.slice(base64.length - third) + base64.slice(third, base64.length - third) + base64.slice(0, third);
  let encoded = "";
  for (const char of reordered) {
    if (char === "=") encoded += "$";
    else encoded += QODER_ALPHABET[QODER_STANDARD_ALPHABET.indexOf(char)] ?? char;
  }
  return Buffer.from(encoded, "latin1");
}

function qoderBuildCosyHeaders(
  body: Uint8Array,
  url: string,
  auth: QoderAuth,
  version = getQoderVersion(),
  profile: QoderModeProfile = MODERN_PROFILE,
): Record<string, string> {
  const key = randomUUID().replaceAll("-", "").slice(0, 16);
  const identity = JSON.stringify({
    name: auth.userName,
    aid: auth.userId,
    uid: auth.userId,
    yx_uid: "",
    organization_id: "",
    organization_name: "",
    user_type: auth.userType,
    security_oauth_token: auth.securityOauthToken,
    refresh_token: auth.refreshToken,
  });
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const info = Buffer.concat([cipher.update(identity), cipher.final()]).toString("base64");
  const cosyKey = publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key)).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({ version: "v1", requestId: randomUUID(), info, cosyVersion: version, ideVersion: "" }),
  ).toString("base64");
  const date = String(Math.floor(Date.now() / 1000));
  const signature = qoderMd5(`${payload}\n${cosyKey}\n${date}\n${Buffer.from(body).toString("latin1")}\n${qoderPathSignature(url)}`);
  return {
    authorization: `Bearer COSY.${payload}.${signature}`,
    "cosy-data-policy": "agree",
    "cosy-machinetype": "5",
    "cosy-machineos": "x86_64_windows",
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": auth.userId,
    "cosy-key": cosyKey,
    "cosy-bodyhash": qoderMd5(body),
    "cosy-bodylength": String(body.byteLength),
    "cosy-sigpath": qoderPathSignature(url),
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "x-request-id": randomUUID(),
    ...(profile.sendBusinessHeaders
      ? {
          "cosy-business-product": profile.businessProduct,
          "cosy-business-type": profile.businessType,
          "cosy-business-version": version,
          "cosy-scene": profile.cosyScene,
        }
      : {}),
    "cosy-version": version,
    "login-version": "v2",
    appcode: QODER_APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    date: new Date().toUTCString(),
    signature: qoderMd5(`${QODER_APPCODE}&${QODER_SIG_SECRET}&${new Date().toUTCString()}`),
    "content-type": "application/json",
    "user-agent": "Go-http-client/2.0",
  };
}

type QoderFetcher = (url: string, init: RequestInit) => Promise<Response>;

async function exchangeQoderPat(
  pat: string,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
  region: QoderRegion = "intl",
): Promise<QoderAuth> {
  const machineId = qoderMachineIdFromPat(pat);
  const encodedBody = transformQoderBody(JSON.stringify({ payload: JSON.stringify({ personalToken: pat, securityOauthToken: "", refreshToken: "", needRefresh: false, authInfo: {} }), encodeVersion: "1" }));
  const response = await fetcher(QODER_JOB_TOKEN_URLS[region], { method: "POST", headers: qoderStaticHeaders(machineId, version), body: encodedBody as unknown as BodyInit, signal });
  if (!response.ok) throw await mapUpstreamHttpError(response, region === "cn" ? "qoder-cn" : "qoder");
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned invalid JSON", {}, "upstream");
  }
  if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody)) {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned unexpected response", {}, "upstream");
  }
  const rec = responseBody as Record<string, unknown>;
  if (typeof rec["id"] !== "string" || typeof rec["securityOauthToken"] !== "string") {
    throw new GatewayError("platform_unavailable", 502, "Qoder PAT exchange returned incomplete credentials", {}, "upstream");
  }
  return {
    userId: rec["id"] as string,
    userName: typeof rec["name"] === "string" ? (rec["name"] as string) : "",
    userType: typeof rec["userType"] === "string" ? (rec["userType"] as string) : "personal_standard",
    securityOauthToken: rec["securityOauthToken"] as string,
    refreshToken: typeof rec["refreshToken"] === "string" ? (rec["refreshToken"] as string) : "",
    machineId,
  };
}

async function callQoder(
  url: string,
  body: Record<string, unknown>,
  modelId: string,
  auth: QoderAuth,
  signal: AbortSignal,
  fetcher: QoderFetcher,
  version = getQoderVersion(),
  profile: QoderModeProfile = MODERN_PROFILE,
): Promise<Response> {
  const encoded = transformQoderBody(JSON.stringify(body));
  const modelConfig = (body["model_config"] as Record<string, unknown> | null) ?? null;
  return fetcher(url, {
    method: "POST",
    headers: {
      ...qoderBuildCosyHeaders(encoded, url, auth, version, profile),
      ...(profile.sendModelSourceHeaders
        ? { "x-model-key": modelId, "x-model-source": typeof modelConfig?.["source"] === "string" ? (modelConfig["source"] as string) : "system" }
        : {}),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
    },
    body: encoded as unknown as BodyInit,
    signal,
  });
}

/**
 * The human-readable text out of a Qoder error envelope.
 *
 * The envelope is Qoder's own wrapper around the stream, and it does not use
 * one field for the message: the text has been seen as a nested `error`
 * object, a bare string `body`, and a top-level `message`/`msg`. The canonical
 * extractor covers the structured shapes; a string body and the top-level
 * fields cover the rest. Whatever survives is bounded the same way an upstream
 * message is, so a verbose envelope cannot blow up the public error line.
 */
function qoderEnvelopeMessage(rec: Record<string, unknown>): string {
  const structured = extractUpstreamMessage(rec["body"]);
  if (structured.length > 0) return structured;
  if (typeof rec["body"] === "string" && rec["body"].trim().length > 0 && rec["body"] !== "[DONE]")
    return rec["body"].replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  return extractUpstreamMessage(rec);
}

/**
 * Structured queue state carried by a `10605` envelope.
 *
 * The payload arrives in several shapes — a bare `{code, message}` pair whose
 * `message` is itself JSON, or the same object forwarded inside a wrapper's
 * `detail` — so the reader walks to the first object that actually names
 * `isQueued` instead of trusting one envelope shape.
 */
function qoderQueueState(message: string): Record<string, unknown> | undefined {
  const at = message.indexOf("{");
  if (at < 0) return undefined;
  const parsed = (() => {
    try {
      return JSON.parse(message.slice(at)) as unknown;
    } catch {
      return undefined;
    }
  })();
  const seen = new Set<unknown>();
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    const rec = candidate as Record<string, unknown>;
    if (rec["isQueued"] !== undefined) return rec;
    for (const key of ["message", "body", "data", "result", "detail"]) {
      const value = rec[key];
      if (typeof value === "string" && value.includes("{")) {
        try {
          pending.push(JSON.parse(value.slice(value.indexOf("{"))));
        } catch {
          // A non-JSON tail is not queue state.
        }
      } else if (typeof value === "object" && value !== null) {
        pending.push(value);
      }
    }
  }
  return undefined;
}

/**
 * Marks a queue rejection the dispatch loop may wait out.
 *
 * `retryAfterMs` is the delay the envelope itself named. It is carried as a
 * detail rather than read from the message, so the loop never parses its own
 * error text to find out how long to sleep.
 */
function qoderQueueError(message: string, status: number): GatewayError | undefined {
  if (!message.includes(QODER_QUEUE_CODE)) return undefined;
  const state = qoderQueueState(message);
  const retryAfter = state === undefined ? undefined : Number(state["retryAfterSeconds"]);
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter !== undefined && retryAfter > 0
      ? retryAfter * 1000
      : QODER_QUEUE_DEFAULT_DELAY_MS;
  return new GatewayError(
    "capacity_exhausted",
    status === 403 ? 429 : status,
    state === undefined
      ? `Qoder queued this model (${QODER_QUEUE_CODE}); retry shortly`
      : `Qoder queued this model (${QODER_QUEUE_CODE}); retry after ${String(state["retryAfterSeconds"] ?? 30)}s`,
    {
      providerId: QODER_PROVIDER_ID,
      providerStatus: status,
      providerCode: QODER_QUEUE_CODE,
      rateLimitScope: "provider",
      retryAfterMs,
    },
    "upstream",
  );
}

/**
 * The queue rejection behind a decoder failure, if that is what it was.
 *
 * The decoder raises `capacity_exhausted` with the upstream's own `10605`
 * provider code for a queued model. Matching on that pair — rather than on the
 * message text — keeps the retry decision tied to the structured evidence and
 * keeps a genuine capacity failure from another source out of the loop.
 */
function qoderQueueFrom(error: unknown): GatewayError | undefined {
  if (!(error instanceof GatewayError)) return undefined;
  if (error.code !== "capacity_exhausted") return undefined;
  if (error.details.providerCode !== QODER_QUEUE_CODE) return undefined;
  return error;
}

/** The delay a queue error named, clamped to the retry budget. */
function queuedDelayMs(error: GatewayError): number {
  const named = typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : QODER_QUEUE_DEFAULT_DELAY_MS;
  return Math.min(Math.max(named, 1_000), QODER_QUEUE_RETRY_BUDGET_MS);
}

/** Abortable wait, so a client disconnect during a queue wait ends the loop. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortFailure(signal) ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortFailure(signal) ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function qoderEnvelopeToFrames(data: string): Array<{ event: string | null; data: string }> {
  if (data === "[DONE]") return [{ event: null, data: "[DONE]" }];
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    // Non-JSON frames are not envelopes and carry no chat payload.
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return [];
  const rec = envelope as Record<string, unknown>;
  if (rec["statusCodeValue"] !== undefined && rec["statusCodeValue"] !== 200) {
    const status = typeof rec["statusCodeValue"] === "number" ? (rec["statusCodeValue"] as number) : 502;
    // Qoder reports the failure inside the stream envelope rather than as an
    // HTTP status, so `mapUpstreamHttpError` never sees it. The code still comes
    // from the one canonical status table, and the details carry the same
    // evidence that function would have attached: a 401/403 is credential
    // evidence (the account is flagged, not silently retried forever) and the
    // envelope body is surfaced instead of a bare status line.
    const detail = qoderEnvelopeMessage(rec);
    const queued = qoderQueueError(detail, status);
    if (queued !== undefined) throw queued;
    throw new GatewayError(
      statusToGatewayErrorCode(status),
      status,
      detail.length > 0 ? detail : `Qoder stream envelope returned HTTP ${status}`,
      {
        providerId: QODER_PROVIDER_ID,
        providerStatus: status,
        ...(status === 401 || status === 403 ? { credentialEvidence: true } : {}),
        ...(status === 429 ? { rateLimitScope: classifyRateLimitScope({ status }) } : {}),
      },
      "upstream",
    );
  }
  const body = rec["body"];
  if (body === "[DONE]") return [{ event: null, data: "[DONE]" }];
  if (typeof body !== "string") return [];
  return [{ event: null, data: body.replace(/\r?\n/g, "") }];
}

function flattenCanonicalContent(content: readonly ContentPart[]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "toolResult")
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "toolResult") return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      return "";
    })
    .join("\n");
}

/**
 * Resolves the effort tier this model will actually apply.
 *
 * Each model accepts its own ladder, so a requested tier that is not on it is
 * clamped upward to the nearest accepted level rather than forwarded — the
 * upstream drops an out-of-ladder value silently, which reads as "the client
 * asked for high and got the default". `none` is honoured only where the model
 * publishes a `disabled` arm; otherwise it falls to the lowest accepted tier.
 */
export function qoderResolveEffort(config: QoderModelConfig, requested: ReasoningEffort | undefined): ReasoningEffort {
  if (config.efforts.length === 0) return "none";
  if (requested === undefined) return config.defaultEffort;
  if (requested === "none") return config.canDisable ? "none" : config.efforts[0]!;
  if (requested === "minimal") return config.efforts[0]!;
  if (config.efforts.includes(requested)) return requested;
  const target = EFFORT_ORDER.indexOf(requested);
  const above = config.efforts.filter((level) => EFFORT_ORDER.indexOf(level) >= target);
  return above[0] ?? config.efforts[config.efforts.length - 1]!;
}

function qoderRequestedMaxTokens(request: CanonicalRequest, modelConfig: QoderModelConfig): number {
  const controls = request.generation_controls as Record<string, unknown>;
  const requested =
    typeof controls["max_tokens"] === "number"
      ? (controls["max_tokens"] as number)
      : typeof controls["max_output_tokens"] === "number"
        ? (controls["max_output_tokens"] as number)
        : null;
  const ceiling = modelConfig.maxOutputTokens;
  return typeof requested === "number" && requested > 0 ? Math.min(requested, ceiling) : ceiling;
}

/**
 * One canonical image part as the upstream `image_url` shape.
 *
 * Qoder takes images inline (data URL) or by URL inside the message content,
 * exactly like the OpenAI chat wire — verified live: a data-URL PNG sent this
 * way is described correctly. Canonical image payloads already carry that
 * shape, so a `url` is reused verbatim and a raw base64 payload is wrapped
 * with the part's own media type.
 */
function qoderImagePart(part: Extract<ContentPart, { kind: "image" }>): Record<string, unknown> | undefined {
  const payload = part.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const rec = payload as Record<string, unknown>;
  const nested = rec["image_url"];
  const direct = typeof nested === "string" ? nested : typeof rec["url"] === "string" ? rec["url"] : undefined;
  if (direct !== undefined) return { type: "image_url", image_url: { url: direct } };
  if (typeof nested === "object" && nested !== null) {
    const inner = (nested as Record<string, unknown>)["url"];
    if (typeof inner === "string") return { type: "image_url", image_url: { url: inner } };
  }
  return undefined;
}

function qoderContentParts(content: readonly ContentPart[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.kind === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.kind === "image") {
      const image = qoderImagePart(part);
      if (image !== undefined) parts.push(image);
    }
  }
  return parts;
}

function qoderToolChoice(choice: CanonicalRequest["tool_choice"]): unknown {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  if (choice.type === "custom") return { type: "function", function: { name: choice.name } };
  return choice.mode === "required" ? "required" : "auto";
}

/** The short session label the native client puts in `business.name`. */
function qoderBusinessName(lastUserText: string): string {
  const collapsed = lastUserText.split(/\s+/).filter(Boolean).join(" ");
  return collapsed.length === 0 ? "OpenAI chat" : collapsed.slice(0, 64);
}

export function buildQoderRequest(
  modelId: string,
  request: CanonicalRequest,
  modelConfig: QoderModelConfig,
  // Part of the shared request-construction entry point: the signing headers
  // consume the credential separately (`callQoder`), and the body itself must
  // not embed it — embedding auth text would be a fingerprint divergence.
  _auth: QoderAuth,
  profile: QoderModeProfile = MODERN_PROFILE,
  options: { version?: string; sessionId?: string; now?: number; requestSetId?: string } = {},
): Record<string, unknown> {
  const version = options.version ?? getQoderVersion();
  const allMessages = request.messages;
  const systemParts: string[] = [];
  if (request.system) {
    for (const p of request.system) if (p.kind === "text") systemParts.push(p.text);
  }
  if (request.instructions) {
    for (const p of request.instructions) if (p.kind === "text") systemParts.push(p.text);
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") {
      const t = flattenCanonicalContent(m.content);
      if (t) systemParts.push(t);
    }
  }
  const callerSystem = systemParts.join("\n\n").trim();
  // The upstream agent gateway identifies the calling channel by this text.
  // With tools declared but no agent prompt the model replies that it has no
  // tools; the caller's own system text therefore rides *after* the vendor
  // prompt instead of replacing it.
  const vendorPrompt = QODER_SYSTEM_PROMPT;
  const systemPrompt = callerSystem.length > 0 ? `${vendorPrompt}\n\n${callerSystem}` : vendorPrompt;
  const qoderMessages: Array<Record<string, unknown>> = [];
  if (profile.mirrorTopLevelSystem && systemPrompt.length > 0) {
    // The leading system turn carries `content` only. Adding a `contents` copy
    // doubles the agent prompt on the wire (~17 KB of text), which the upstream
    // answers by holding the request in its model queue instead of serving it.
    qoderMessages.push({
      role: "system",
      content: systemPrompt,
    });
  }
  for (const m of allMessages) {
    if (m.role === "system" || m.role === "developer") continue;
    // Answers may live in a `user` turn (the Messages ledger re-homes them),
    // so the result scan is role-agnostic. Each result becomes its own `tool`
    // turn carrying its `tool_call_id`; any non-result content on the same turn
    // is emitted after, so nothing is duplicated or lost.
    const results = toolResultParts(m);
    if (results.length > 0) {
      for (const block of results) {
        const text = flattenCanonicalContent(
          typeof block.content === "string"
            ? [{ kind: "text", text: block.content }]
            : block.content,
        );
        qoderMessages.push({
          role: "tool",
          content: text,
          contents: [{ type: "text", text }],
          tool_call_id: block.call_id,
        });
      }
      const remaining = m.content.filter((part) => part.kind !== "toolResult");
      if (remaining.length === 0) continue;
      const flat = flattenCanonicalContent(remaining);
      qoderMessages.push({
        role: "user",
        content: flat,
        contents: [{ type: "text", text: flat }],
      });
      continue;
    }
    const calls = toolCallParts(m);
    if (calls.length > 0) {
      // The upstream replays the previous turn's calls as `tool_calls` with
      // their original ids, so the following `tool` turns pair up. Dropping
      // them turns every tool round into a plain assistant message and the
      // model re-issues the call instead of continuing the task.
      qoderMessages.push({
        role: "assistant",
        content: flattenCanonicalContent(m.content.filter((part) => part.kind === "text")),
        contents: [{ type: "text", text: flattenCanonicalContent(m.content) }],
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.call_id,
          type: "function",
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        })),
      });
      const textOnly = m.content.filter((part) => part.kind === "text");
      if (textOnly.length > 0) continue;
    }
    const rich = m.content.some((part) => part.kind === "image");
    if (rich) {
      // The upstream reads the `contents` mirror, not `content`, when a turn
      // carries an image: the native client fills both fields with the same
      // part array. A text-only `contents` makes the model answer that no
      // image was attached even though `content` holds it.
      const parts = qoderContentParts(m.content);
      qoderMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: parts,
        contents: parts,
      });
      continue;
    }
    const flat = flattenCanonicalContent(m.content);
    qoderMessages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: flat,
      contents: [{ type: "text", text: flat }],
    });
  }
  // The latest user text drives `chat_context`, and it has to be read from the
  // canonical turn rather than back off the built message: an image turn's
  // content is an array of parts, so a string-only read left the instruction
  // empty and the model answered that no image had been attached.
  const latestUserText = (() => {
    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const message = allMessages[i]!;
      if (message.role !== "user") continue;
      const text = flattenCanonicalContent(message.content).trim();
      if (text.length > 0) return text;
    }
    return "";
  })();
  const maxTokens = qoderRequestedMaxTokens(request, modelConfig);
  const effort = qoderResolveEffort(modelConfig, request.reasoning?.effort);
  const thinkingEnabled = effort !== "none";
  // `model_config.is_reasoning` is the catalog capability, not this request's
  // intent: the native client sets it from the model row and carries the tier
  // in `parameters.reasoning_effort`. Deriving it from the effort made a
  // reasoning model advertise `is_reasoning: false` whenever the caller sent
  // no effort, which the gateway answers by queueing the request.
  const reasoning = modelConfig.reasoning;
  // Native reuses one engine session id across every model/tool iteration, and
  // honours the id a client supplies (`X-Session-Id`); generating a fresh one
  // per HTTP request discards the conversation's continuity upstream.
  const sessionId = options.sessionId ?? resolveInboundSessionId(undefined, request) ?? randomUUID();
  const requestId = randomUUID();
  // `request_id` and `request_set_id` are distinct in the native body: a queue
  // retry rotates `request_id` while the set id stays, which is what tells the
  // upstream "this is the same task, already accepted" instead of re-running it.
  const requestSetId = options.requestSetId ?? randomUUID();
  const now = options.now ?? Date.now();
  const parameters: Record<string, unknown> = { max_tokens: maxTokens };
  // Native sends the thinking switches only for an explicit client knob; a
  // default run carries `max_tokens` alone and the server applies the model's
  // own `thinking_config` default. Both fields are per-model enums, so the
  // clamped tier above is what may be forwarded.
  if (request.reasoning?.effort !== undefined) {
    parameters["reasoning_effort"] = effort;
    parameters["enable_thinking"] = thinkingEnabled;
  }
  const toolChoice = qoderToolChoice(request.tool_choice);
  if (toolChoice !== undefined) parameters["tool_choice"] = toolChoice;
  // Key order matches the native builder exactly. The gateway fingerprints
  // the serialized body, so a reordered object is a different request even
  // when every value is identical.
  return {
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    ...(profile.emptyAliyunUserType ? { aliyun_user_type: "" } : {}),
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: profile.mirrorTopLevelSystem ? systemPrompt : "",
    image_urls: null,
    chat_context: {
      chatPrompt: profile.mirrorTopLevelSystem ? systemPrompt : "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: modelId, is_reasoning: reasoning }, originalContent: latestUserText },
      features: [],
      text: latestUserText,
    },
    model_config: {
      key: modelId,
      display_name: modelConfig.displayName,
      model: "",
      format: "openai",
      is_vl: modelConfig.vision,
      is_reasoning: reasoning,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: modelConfig.maxInputTokens,
      // `kmodel` is the one row that publishes a fast-mode switch, and the
      // native client ships it enabled; a body without it runs the slow path.
      ...(modelConfig.fastSwitch === true ? { function_switches: { fast: true } } : {}),
    },
    system: systemPrompt,
    messages: qoderMessages,
    tools: (request.tools ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.jsonSchema,
      },
    })),
    parameters,
    business: {
      product: MODERN_PROFILE.businessProduct,
      version,
      type: MODERN_PROFILE.businessType,
      id: randomUUID(),
      name: qoderBusinessName(latestUserText),
      begin_at: now,
      stage: "start",
    },
  };
}

// Stream transformation — decode SSE, unwrap COSY envelope, map OpenAI chat chunks to CanonicalEvent

function mapQoderFinishReason(raw: unknown): CanonicalStopReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls") return "tool_use";
  if (raw === "content_filter") return "content_filter";
  return undefined;
}

async function* qoderBodyToCanonicalEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  model: string,
): AsyncIterable<CanonicalEvent> {
  let seq = 1;
  // `response_start` is deferred until the first payload proves the turn is
  // being served. A queued attempt answers with an envelope error instead of
  // content, and emitting a start first would leave the caller having observed
  // a stream that then failed — with the retry arriving as a second start.
  let started = false;
  let finishReason: unknown = undefined;
  let rawUsage: Record<string, unknown> | undefined = undefined;
  let produced = false;
  // Qoder names a tool call only on its first fragment; every later fragment
  // carries the index and argument bytes alone. Inventing a placeholder id for
  // those continuations makes them look like a second, nameless call, which is
  // why the assembled call lost its `id` and `name`. The id and name are
  // remembered per index and repeated on each fragment.
  const callIdByIndex = new Map<number, string>();
  const callNameByIndex = new Map<number, string>();

  for await (const sse of decodeSseEvents(body, { signal })) {
    const frames = qoderEnvelopeToFrames(sse.data);
    for (const frame of frames) {
      const data = frame.data.trim();
      if (!data) continue;
      if (data === "[DONE]") continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!started) {
        started = true;
        yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
      }
      if (json["usage"] && typeof json["usage"] === "object") rawUsage = json["usage"] as Record<string, unknown>;
      const choices = (json["choices"] as Array<Record<string, unknown>>) ?? [];
      for (const choice of choices) {
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta["content"] === "string" && (delta["content"] as string).length > 0) {
            produced = true;
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "text", text: delta["content"] as string },
            } as CanonicalEvent;
          }
          const reasoningText = readReasoningText(delta);
          if (typeof reasoningText === "string" && reasoningText.length > 0) {
            produced = true;
            yield {
              type: "content_delta",
              sequence_number: seq++,
              content: { kind: "reasoning", payload: null, summary: reasoningText },
            } as CanonicalEvent;
          }
          const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            produced = true;
            for (const tc of toolCalls) {
              const fn = tc["function"] as Record<string, unknown> | undefined;
              const index = typeof tc["index"] === "number" ? (tc["index"] as number) : 0;
              const fragmentId = typeof tc["id"] === "string" && tc["id"].length > 0 ? (tc["id"] as string) : undefined;
              if (fragmentId !== undefined) callIdByIndex.set(index, fragmentId);
              const fragmentName =
                typeof fn?.["name"] === "string" && (fn["name"] as string).length > 0
                  ? (fn["name"] as string)
                  : undefined;
              if (fragmentName !== undefined) callNameByIndex.set(index, fragmentName);
              yield {
                type: "tool_call_delta",
                sequence_number: seq++,
                call_id: callIdByIndex.get(index) ?? `call_${index}`,
                index,
                ...(callNameByIndex.has(index) ? { name: callNameByIndex.get(index) } : {}),
                arguments_delta: (fn?.["arguments"] as string) ?? "",
              } as CanonicalEvent;
            }
          }
        }
        const fr = choice["finish_reason"];
        if (fr !== null && fr !== undefined) finishReason = fr;
        // Some providers send usage in choices[0].usage or top-level
        if (choice["usage"] && typeof choice["usage"] === "object") rawUsage = choice["usage"] as Record<string, unknown>;
      }
      // Some Qoder chunks carry finish_reason at top level
      if (json["finish_reason"] !== undefined) finishReason = json["finish_reason"];
    }
  }
  // A stream that closes with neither content nor a finish reason is not an
  // empty answer — it is the upstream dropping the turn (the model-queue path
  // answers 200 and then holds the request). Reporting it as `complete` would
  // hand the caller an empty success and skip failover, so it fails instead.
  if (!started) {
    started = true;
    yield { type: "response_start", sequence_number: seq++, model } as CanonicalEvent;
  }
  if (!produced && finishReason === undefined) {
    // A bare `[DONE]` with no payload is the sentinel the local dispatch and
    // tests rely on: the turn was answered, just without visible text. Keep
    // the complete terminal; a genuinely empty model queue path answers with
    // an error envelope (code 10605) that the decoder raises above instead.
    yield {
      type: "terminal",
      sequence_number: seq++,
      state: "complete",
      ...(mapQoderFinishReason(finishReason) === undefined
        ? {}
        : { stop_reason: mapQoderFinishReason(finishReason) }),
      ...(typeof finishReason === "string" ? { provider_stop_reason: finishReason } : {}),
      usage: usageFromProvider(rawUsage),
    } as CanonicalEvent;
    return;
  }
  const stopReason = mapQoderFinishReason(finishReason);
  const providerStop = typeof finishReason === "string" ? finishReason : undefined;
  yield {
    type: "terminal",
    sequence_number: seq++,
    state: "complete",
    ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    ...(providerStop === undefined ? {} : { provider_stop_reason: providerStop }),
    usage: usageFromProvider(rawUsage),
  } as CanonicalEvent;
}

// Model catalog — maps a region's config table to LianRouter ModelDefinitions

const QODER_CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1" as const;

function qoderCatalog(configs: QoderModelConfigMap): readonly ModelDefinition[] {
  return Object.entries(configs).map(([id, cfg]) =>
    defineModel({
      id,
      endpoint: QODER_CHAT_PATH,
      ctx: cfg.maxInputTokens,
      out: cfg.maxOutputTokens ?? 32768,
      vision: cfg.vision,
      reasoning: cfg.reasoning,
      ...(cfg.efforts.length > 0 ? { reasoningEfforts: cfg.efforts } : {}),
      ...(cfg.free === true ? { free: true } : {}),
    }),
  );
}

export const QODER_MODELS: readonly ModelDefinition[] = qoderCatalog(QODER_MODEL_CONFIGS);
export const QODER_CN_MODELS: readonly ModelDefinition[] = qoderCatalog(QODER_CN_MODEL_CONFIGS);

/**
 * Reads the live chat catalog with the same COSY-signed GET the CLI issues.
 *
 * The static `QODER_MODELS` list is the dispatch contract and ships with the
 * build; this reader lets the console sync the upstream catalog (a new tier
 * key, a retired model) without a release. It signs with an empty body — the
 * endpoint is a GET, and the signature covers the body bytes, so a non-empty
 * buffer would not verify.
 */
export async function discoverQoderModels(input: {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = (input.fetcher ?? globalThis.fetch) as QoderFetcher;
  const signal = AbortSignal.timeout(20_000);
  const version = await resolveQoderVersion(fetcher as unknown as typeof fetch, signal);
  const auth = await exchangeQoderPat(input.credential.trim(), signal, fetcher, version);
  const url = "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1";
  const empty = new Uint8Array(0);
  const response = await fetcher(url, {
    method: "GET",
    headers: { ...qoderBuildCosyHeaders(empty, url, auth, version), accept: "application/json" },
    signal,
  });
  if (!response.ok) throw await mapUpstreamHttpError(response, QODER_PROVIDER_ID);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  return parseQoderModelList(payload);
}

/**
 * Model catalog as published by the upstream (`GET /algo/api/v2/model/list`).
 *
 * The static list above is the dispatch contract; this reader exists so the
 * console can sync the live catalog without a build. It keeps the same
 * capability mapping (`is_reasoning`, `is_vl`, the per-model thinking ladder)
 * and returns `null` for anything it cannot classify, rather than inventing a
 * row the adapter would then have to guess at.
 */
export function parseQoderModelList(payload: unknown): readonly ModelDefinition[] | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const chat = (payload as Record<string, unknown>)["chat"];
  if (!Array.isArray(chat)) return null;
  const definitions: ModelDefinition[] = [];
  for (const entry of chat) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const key = typeof rec["key"] === "string" ? rec["key"] : undefined;
    if (key === undefined || rec["enable"] === false) continue;
    const thinking = (rec["thinking_config"] as Record<string, unknown> | undefined) ?? {};
    const enabled = typeof thinking["enabled"] === "object" && thinking["enabled"] !== null
      ? (thinking["enabled"] as Record<string, unknown>)
      : undefined;
    const efforts = typeof enabled?.["efforts"] === "object" && enabled["efforts"] !== null
      ? Object.keys(enabled["efforts"] as Record<string, unknown>).filter((level): level is ReasoningEffort =>
          EFFORT_ORDER.includes(level as ReasoningEffort),
        )
      : [];
    const ordered = EFFORT_ORDER.filter((level) => efforts.includes(level));
    const maxInput = typeof rec["max_input_tokens"] === "number" ? (rec["max_input_tokens"] as number) : 180_000;
    definitions.push(
      defineModel({
        id: key,
        endpoint: "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
        ctx: maxInput,
        out: QODER_DEFAULT_MAX_OUTPUT_TOKENS,
        vision: rec["is_vl"] === true,
        reasoning: rec["is_reasoning"] === true,
        ...(ordered.length > 0 ? { reasoningEfforts: ordered } : {}),
        ...(rec["is_free"] === true ? { free: true } : {}),
      }),
    );
  }
  return definitions.length > 0 ? definitions : null;
}

// ProviderAdapter — manual dispatch preserving COSY encryption + envelope logic

interface QoderAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly region?: QoderRegion;
}

/**
 * One adapter per region. The codec — COSY signing, body scrambling, envelope
 * unwrapping — is identical; only the host set, the job-token endpoint, and the
 * model catalog differ, so the region is a constructor input rather than a
 * second implementation.
 */
class QoderAdapter implements ProviderAdapter {
  readonly provider_id: typeof QODER_PROVIDER_ID | typeof QODER_CN_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly region: QoderRegion;
  private readonly profile: QoderModeProfile;
  private readonly modelConfigs: QoderModelConfigMap;

  constructor(options: QoderAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.region = options.region ?? "intl";
    this.profile = QODER_REGION_PROFILES[this.region];
    this.modelConfigs = this.region === "cn" ? QODER_CN_MODEL_CONFIGS : QODER_MODEL_CONFIGS;
    this.provider_id = this.region === "cn" ? QODER_CN_PROVIDER_ID : QODER_PROVIDER_ID;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError("capability_unsupported", 400, `${this.provider_id} supports chat only, got ${candidate.wire_family}`);
    }
    const pat = readCredentialSecret(context.credential, "Qoder PAT is required");

    const modelId = candidate.model_id || request.model;
    const modelConfig = this.modelConfigs[modelId] ?? {
      id: modelId,
      displayName: modelId,
      maxInputTokens: 180_000,
      maxOutputTokens: QODER_DEFAULT_MAX_OUTPUT_TOKENS,
      vision: true,
      reasoning: false,
      efforts: [],
      defaultEffort: "none" as ReasoningEffort,
      canDisable: false,
    };

    const lifecycle = createUpstreamDeadlineLifecycle(context);

    // Outbound fetch respects SSRF binding when provided
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;

    const fetcher: QoderFetcher = (url, init) =>
      outboundFetch(url, { ...init, signal: lifecycle.signal } as RequestInit) as Promise<Response>;

    try {
      const version = await resolveQoderVersion(outboundFetch, lifecycle.signal);
      const auth = await exchangeQoderPat(pat, lifecycle.signal, fetcher, version, this.region);
      const url =
        candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
          ? candidate.endpoint_path
          : this.profile.chatUrl;

      // A queued model is not a dead account, and a single-PAT provider has no
      // sibling to rotate to: the account IS the provider. Rotating would park
      // the only account that can serve the request, so the queue is waited out
      // here instead — the same recovery the official client performs. The
      // wait is bounded by the request's own deadline so a long queue cannot
      // hold a gateway slot past it.
      const queueDeadline = Math.min(
        Date.now() + QODER_QUEUE_RETRY_BUDGET_MS,
        context.deadline - QODER_QUEUE_DEADLINE_MARGIN_MS,
      );
      // `request_set_id` survives the retries; `request_id` is rotated, which is
      // how the upstream recognizes the resend as the same accepted task.
      const requestSetId = randomUUID();
      const queueStartedAt = Date.now();
      for (let attempt = 0; ; attempt += 1) {
        // Every attempt carries the same set id — that is the whole point of
        // it — while `request_id`/`chat_record_id` are regenerated per attempt.
        const qoderBody = buildQoderRequest(modelId, request, modelConfig, auth, this.profile, { version, requestSetId });
        const response = await callQoder(url, qoderBody, modelId, auth, lifecycle.signal, fetcher, version, this.profile);
        if (!response.ok) throw await mapUpstreamHttpError(response, this.provider_id);
        if (!response.body) throw new GatewayError("platform_unavailable", 502, "Qoder returned empty body", {}, "upstream");
        // Headers arrived: the pre-stream deadline has served its purpose.
        // From here the gateway stall/first-chunk watchdog (propagated via
        // context.abort_signal) governs the body. Keeping this timer armed
        // would kill healthy long streams at the stale pre-stream deadline.
        lifecycle.release();
        try {
          yield* qoderBodyToCanonicalEvents(response.body as ReadableStream<Uint8Array>, lifecycle.signal, request.model);
          return;
        } catch (error: unknown) {
          // The decoder raises the queue verdict before emitting a single
          // event, so a retry is invisible to the caller.
          const queued = qoderQueueFrom(error);
          if (queued === undefined) throw error;
          const delay = queuedDelayMs(queued);
          if (Date.now() + delay > queueDeadline) {
            // Say what was actually tried. A bare "queued" after three waits
            // reads as a bug; the retry count and elapsed time make it a
            // throttle an operator can act on.
            const waited = Math.round((Date.now() - queueStartedAt) / 1000);
            throw new GatewayError(
              queued.code,
              queued.status,
              `${queued.message} — still throttled after ${attempt + 1} attempt${attempt === 0 ? "" : "s"} over ${waited}s`,
              queued.details,
              "upstream",
            );
          }
          await sleepAbortable(delay, lifecycle.signal);
        }
      }
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      const failure = abortFailure(lifecycle.signal, err);
      if (failure) throw failure;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createQoderAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter(options);
}

export function createQoderCnAdapter(options: Omit<QoderAdapterOptions, "region"> = {}): ProviderAdapter {
  return new QoderAdapter({ ...options, region: "cn" });
}

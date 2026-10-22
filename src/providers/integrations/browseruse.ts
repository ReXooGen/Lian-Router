/**
 * Browser Use V4 gateway.
 *
 * One bearer token serves two dialects from one origin: OpenAI
 * `/v1/chat/completions` for DeepSeek and Anthropic `/anthropic/v1/messages`
 * for the Claude family. The gateway decides how to treat a request from the
 * client identity, so the Messages wire stamps the Claude Code CLI headers —
 * without them it answers with a synthetic run-exit stub instead of model
 * output. The OpenAI wire carries no identity gate.
 *
 * The gateway's response framing is sloppy (a plain JSON answer keeps the SSE
 * terminator, and the body may be labeled `text/event-stream` regardless).
 * That repair lives in the shared transport (`protocol/transport/framing.ts`)
 * so a BYOK row pointed at the same gateway gets it too, not only this
 * bundled provider.
 */
import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";
import { buildCustomClaudeCliHeaders } from "../operations/custom-cli-headers";

/** Gateway prefix in front of both dialects; the base URL is an origin. */
const V4_PREFIX = "/api/v4/llm";
const CHAT_PATH = `${V4_PREFIX}/v1/chat/completions`;
const MESSAGES_PATH = `${V4_PREFIX}/anthropic/v1/messages`;

export const BROWSERUSE_SPEC: ApiKeyProviderSpec = {
  provider_id: "browseruse",
  // One origin, two dialects: the credential is a bearer token on both, which
  // is why they share one provider row instead of an OpenAI-compatible row
  // plus an Anthropic-compatible one.
  supported_wire_families: ["chat", "messages"],
  endpoint_paths_by_wire_family: {
    chat: CHAT_PATH,
    messages: MESSAGES_PATH,
  },
  // The Messages path gates on the Claude Code fingerprint (`claude-cli/...`
  // user agent and `x-app: cli`), so a naked client is served a run-exit stub
  // rather than the model answer. The chat path has no such gate and keeps the
  // transport default.
  buildExtraHeaders: (_context, _request, candidate) =>
    candidate?.wire_family === "messages" ? buildCustomClaudeCliHeaders() : {},
};

/**
 * The five models the gateway has been verified to serve. Capabilities follow
 * the gateway's own model registry: every row accepts tools, images, PDFs, and
 * reasoning controls. Limits and pricing are left to the shared catalog
 * defaults — the gateway publishes no per-model limits, and inventing them
 * would make the router's eligibility checks assert something unverifiable.
 */
export const BROWSERUSE_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "deepseek-v4.1-flash",
    providerId: "browseruse",
    wireFamily: "chat",
    endpoint: CHAT_PATH,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "claude-sonnet-5",
    providerId: "browseruse",
    wireFamily: "messages",
    endpoint: MESSAGES_PATH,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "claude-opus-5",
    providerId: "browseruse",
    wireFamily: "messages",
    endpoint: MESSAGES_PATH,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "claude-fable-5",
    providerId: "browseruse",
    wireFamily: "messages",
    endpoint: MESSAGES_PATH,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  }),
  defineModel({
    id: "claude-opus-4-7",
    providerId: "browseruse",
    wireFamily: "messages",
    endpoint: MESSAGES_PATH,
    vision: true,
    document: true,
    reasoning: true,
    toolCall: true,
  }),
];

import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Minimax Coding — the 4 chat model id(s) its published catalog lists. */
export const MINIMAX_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMax-M3", providerId: "minimax", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.7", providerId: "minimax", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.5", providerId: "minimax", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.1", providerId: "minimax", wireFamily: "messages", endpoint: "/v1/messages?beta=true", reasoning: true }),
];

/** Minimax (China) — the 4 chat model id(s) its published catalog lists. */
export const MINIMAX_CN_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMax-M3", providerId: "minimax-cn", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.7", providerId: "minimax-cn", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.5", providerId: "minimax-cn", wireFamily: "messages", endpoint: "/v1/messages?beta=true", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.1", providerId: "minimax-cn", wireFamily: "messages", endpoint: "/v1/messages?beta=true", reasoning: true }),
];

/** MiniMax Code — the 4 chat model id(s) its published catalog lists. */
export const MINIMAX_CODE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMax-M3.1-Flash-Preview", providerId: "minimax-code", wireFamily: "messages", endpoint: "/v1/messages", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M3", providerId: "minimax-code", wireFamily: "messages", endpoint: "/v1/messages", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.7", providerId: "minimax-code", wireFamily: "messages", endpoint: "/v1/messages", reasoning: true }),
  defineModel({ id: "MiniMax-M2.7-highspeed", providerId: "minimax-code", wireFamily: "messages", endpoint: "/v1/messages", reasoning: true }),
];

/** MiniMax Code (Global) — the 4 chat model id(s) its published catalog lists. */
export const MINIMAX_CODE_GLOBAL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMax-M3.1-Flash-Preview", providerId: "minimax-code-global", wireFamily: "messages", endpoint: "/v1/messages", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M3", providerId: "minimax-code-global", wireFamily: "messages", endpoint: "/v1/messages", vision: true, reasoning: true }),
  defineModel({ id: "MiniMax-M2.7", providerId: "minimax-code-global", wireFamily: "messages", endpoint: "/v1/messages", reasoning: true }),
  defineModel({ id: "MiniMax-M2.7-highspeed", providerId: "minimax-code-global", wireFamily: "messages", endpoint: "/v1/messages", reasoning: true }),
];

export const MINIMAX_SPEC: ApiKeyProviderSpec = {
  provider_id: "minimax",
  supported_wire_families: ["messages"],
  endpoint_paths_by_wire_family: { messages: "/v1/messages?beta=true" },
  // The upstream reads the credential from `x-api-key`, so it is stamped here
  // and never forwarded as an Authorization header.
  credential_forwarding: "never",
  buildExtraHeaders: (context) => {
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return {};
    return {
      "x-api-key": new TextDecoder().decode(secret).trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    };
  },
};

export const MINIMAX_CN_SPEC: ApiKeyProviderSpec = {
  provider_id: "minimax-cn",
  supported_wire_families: ["messages"],
  endpoint_paths_by_wire_family: { messages: "/v1/messages?beta=true" },
  // The upstream reads the credential from `x-api-key`, so it is stamped here
  // and never forwarded as an Authorization header.
  credential_forwarding: "never",
  buildExtraHeaders: (context) => {
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return {};
    return {
      "x-api-key": new TextDecoder().decode(secret).trim(),
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
    };
  },
};

export const MINIMAX_CODE_SPEC: ApiKeyProviderSpec = {
  provider_id: "minimax-code",
  supported_wire_families: ["messages"],
  endpoint_paths_by_wire_family: { messages: "/v1/messages" },
  extra_headers: {
    "user-agent": "MiniMaxAgent",
    "x-mavis-agent-id": "main",
    "x-api-key": "sk-xxx",
  },
};

export const MINIMAX_CODE_GLOBAL_SPEC: ApiKeyProviderSpec = {
  provider_id: "minimax-code-global",
  supported_wire_families: ["messages"],
  endpoint_paths_by_wire_family: { messages: "/v1/messages" },
  extra_headers: {
    "user-agent": "MiniMaxAgent",
    "x-mavis-agent-id": "main",
    "x-api-key": "sk-xxx",
  },
};

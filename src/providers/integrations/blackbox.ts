import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Blackbox AI — the 10 chat model id(s) its published catalog lists. */
export const BLACKBOX_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "claude-fable-5", providerId: "blackbox", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4.8", providerId: "blackbox", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4.6", providerId: "blackbox", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.5", providerId: "blackbox", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4-pro", providerId: "blackbox", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4", providerId: "blackbox", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.3-codex", providerId: "blackbox", reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4-nano", providerId: "blackbox", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "blackbox", reasoning: true }),
  defineModel({ id: "grok-4.3", providerId: "blackbox", vision: true, reasoning: true, webSearch: true }),
];

export const BLACKBOX_SPEC: ApiKeyProviderSpec = {
  provider_id: "blackbox",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
  // The catalog id is a routing alias; the upstream `model` field carries
  // the id the provider actually serves.
  prePayload: (payload) => {
    const model = payload["model"];
    if (typeof model !== "string") return;
    const upstream: Readonly<Record<string, string>> = {"claude-fable-5": "blackboxai/anthropic/claude-fable-5", "claude-opus-4.8": "blackboxai/anthropic/claude-opus-4.8", "claude-sonnet-4.6": "blackboxai/anthropic/claude-sonnet-4.6", "gpt-5.5": "blackboxai/openai/gpt-5.5", "gpt-5.4-pro": "blackboxai/openai/gpt-5.4-pro", "gpt-5.4": "blackboxai/openai/gpt-5.4", "gpt-5.3-codex": "blackboxai/openai/gpt-5.3-codex", "gpt-5.4-nano": "blackboxai/openai/gpt-5.4-nano", "deepseek-v4-flash": "blackboxai/deepseek/deepseek-v4-flash", "grok-4.3": "blackboxai/x-ai/grok-4.3"};
    const mapped = upstream[model];
    if (mapped !== undefined) payload["model"] = mapped;
  },
};

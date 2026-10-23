import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";

export const CURSOR_PROVIDER_ID = "cursor" as const;
export const CURSOR_BASE_URL = providerBaseUrl(CURSOR_PROVIDER_ID);
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run" as const;

function cursorModel(modelId: string, reasoning: boolean): ModelDefinition {
  return defineModel({
    id: modelId,
    wireFamily: "native",
    endpoint: CURSOR_RUN_PATH,
    ctx: 200_000,
    out: 64_000,
    vision: true,
    reasoning,
    toolCall: false,
    webSearch: true,
  });
}

/**
 * Static fallback catalog; live discovery runs through GetUsableModels.
 *
 * Cursor exposes effort/thinking as separate selectable model ids rather than a
 * request parameter, so each variant is its own row. This list is a fallback
 * only: `GetUsableModels` is authoritative for what an account can actually
 * select, and a row here that the account cannot use fails at dispatch with the
 * upstream's own error rather than being silently rewritten.
 */
export const CURSOR_MODELS: readonly ModelDefinition[] = [
  cursorModel("default", false),
  cursorModel("claude-4.5-opus", true),
  cursorModel("claude-4.5-opus-high", true),
  cursorModel("claude-4.5-opus-high-thinking", true),
  cursorModel("claude-4.5-sonnet", true),
  cursorModel("claude-4.5-sonnet-thinking", true),
  cursorModel("claude-4.5-haiku", false),
  cursorModel("claude-4.6-opus-high", true),
  cursorModel("claude-4.6-opus-max", true),
  cursorModel("claude-4.6-sonnet-medium", true),
  cursorModel("claude-4.6-sonnet-medium-thinking", true),
  cursorModel("gpt-5.2", true),
  cursorModel("gpt-5.2-codex", true),
  cursorModel("gpt-5.3-codex", true),
  cursorModel("gemini-3-flash-preview", true),
  cursorModel("kimi-k2.5", true),
  cursorModel("composer-2.5", false),
  cursorModel("composer-2.5-fast", false),
];

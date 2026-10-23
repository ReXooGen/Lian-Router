import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** GitHub Copilot — the 17 chat and 2 embedding model id(s) its published catalog lists. */
export const GITHUB_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-5.2", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.2-codex", providerId: "github", reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.3-codex", providerId: "github", reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4-mini", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-haiku-4.5", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4.5", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4.5", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4.6", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4.6", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-4.7", providerId: "github", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-2.5-pro", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-3-flash-preview", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-3.1-pro-preview", providerId: "github", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-code-fast-1", providerId: "github", reasoning: true }),
  defineModel({ id: "oswe-vscode-prime", providerId: "github" }),
  defineModel({ id: "goldeneye-free-auto", providerId: "github" }),
  // Copilot serves embeddings on a bare `/embeddings` path under its host —
  // there is no `/v1` segment here, unlike the OpenAI wire it imitates.
  defineModel({ id: "text-embedding-3-small", providerId: "github", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
  defineModel({ id: "text-embedding-ada-002", providerId: "github", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
];

export const GITHUB_SPEC: ApiKeyProviderSpec = {
  provider_id: "github",
  supported_wire_families: ["chat", "embeddings"],
  endpoint_paths_by_wire_family: { embeddings: "/embeddings" },
  extra_headers: {
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.110.0",
    "editor-plugin-version": "copilot-chat/0.38.0",
    "user-agent": "GitHubCopilotChat/0.38.0",
    "openai-intent": "conversation-panel",
    "x-github-api-version": "2025-04-01",
    "x-vscode-user-agent-library-version": "electron-fetch",
  },
};

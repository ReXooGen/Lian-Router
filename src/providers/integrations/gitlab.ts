/**
 * GitLab Duo Chat adapter.
 *
 * GitLab's own REST surface is *not* the OpenAI chat envelope, despite the
 * registry entry's `format` default: `POST /chat/completions` takes a single
 * `content` string and answers with a JSON string
 * (https://docs.gitlab.com/api/chat/). Two consequences the code below makes
 * explicit rather than papering over:
 *
 *   - The canonical conversation is flattened into one `content` string. Duo
 *     keeps the thread server-side and takes no `messages` array, so there is
 *     no per-request history to send; tools and response-format controls have
 *     no wire representation either and are dropped.
 *   - The upstream answer is not streamed. A streaming client gets one text
 *     delta followed by a terminal event synthesized from the same body, which
 *     is what the surface would have produced from a non-streamed upstream.
 *
 * The model id is not part of the request: GitLab chooses the model for the
 * account, so the static catalog is empty and the operator registers nothing.
 */
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { joinTextParts } from "../../transport/canonical-model";
import { postUpstreamJson } from "../../protocol/transport/openai";
import { parseChatResponseToEvents } from "../../protocol/response/chat";
import { joinUrl } from "../../protocol/primitives";
import {
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";

export const GITLAB_PROVIDER_ID = "gitlab" as const;
export const GITLAB_BASE_URL = providerBaseUrl(GITLAB_PROVIDER_ID);

/** GitLab's documented request field. */
const GITLAB_CHAT_PATH = "/chat/completions";

/**
 * Flattens the canonical conversation into the one string GitLab accepts.
 * Roles are labelled rather than concatenated bare, because Duo reads the text
 * as a single user turn and an unlabelled multi-party blob loses who said what.
 */
export function buildGitlabContent(request: CanonicalRequest): string {
  const blocks: string[] = [];
  const system = [...(request.system ?? []), ...(request.instructions ?? [])];
  const systemText = joinTextParts(system);
  if (systemText.length > 0) blocks.push(`System: ${systemText}`);
  for (const message of request.messages) {
    const text = joinTextParts(message.content);
    if (text.length === 0) continue;
    blocks.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${text}`);
  }
  return blocks.join("\n\n");
}

export interface GitlabAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class GitlabAdapter implements ProviderAdapter {
  readonly provider_id = GITLAB_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: GitlabAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? GITLAB_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `gitlab supports chat only, got ${candidate.wire_family}`,
      );
    }
    const token = readCredentialSecret(context.credential, "GitLab access token is required");
    const content = buildGitlabContent(request);
    if (content.length === 0) {
      throw new GatewayError("invalid_request", 400, "GitLab Duo requires at least one message");
    }

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const { res, release } = await postUpstreamJson(
      joinUrl(this.baseUrl, GITLAB_CHAT_PATH),
      {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      { content },
      context,
      outboundFetch,
    );
    try {
      if (!res.ok) throw await mapUpstreamHttpError(res, GITLAB_PROVIDER_ID);
      // Documented response is a bare JSON string; an object envelope is
      // tolerated so a self-managed instance that wraps the text still works.
      const body: unknown = await res.json();
      const text =
        typeof body === "string"
          ? body
          : typeof (body as Record<string, unknown> | null)?.["content"] === "string"
            ? ((body as Record<string, unknown>)["content"] as string)
            : undefined;
      if (text === undefined) {
        throw new GatewayError(
          "platform_unavailable",
          502,
          "GitLab Duo returned no chat text",
          {},
          "upstream",
        );
      }
      yield* parseChatResponseToEvents(
        {
          id: `chatcmpl-gitlab-${Date.now()}`,
          object: "chat.completion",
          model: candidate.model_id || request.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        },
        request,
      );
    } finally {
      release();
    }
  }
}

export function createGitlabAdapter(options: GitlabAdapterOptions = {}): ProviderAdapter {
  return new GitlabAdapter(options);
}

import type { PromptInjection } from "../../persistence/schema";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { DrizzlePromptInjectionStore } from "../../persistence/prompt-injection-store";
import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../canonical-model";

/**
 * Prompt Injection application.
 *
 * Entries are applied to the **canonical** request, before any adapter encodes
 * a wire. That is what makes the feature wire-aware without four copies of the
 * injector: the Chat encoder turns canonical system parts into `messages[0]`,
 * the Messages encoder into `system`, and Responses into `instructions`.
 *
 * Ordering follows the stack the operator sees: global → key → model.
 * `prepend` entries land before the request's own system text, `append`
 * entries after it, and every entry keeps its stack order within its position.
 *
 * Two invariants matter:
 *
 * - **Idempotent.** A text already present as its own system part is not added
 *   again; the same scripted turns already sitting at the insertion point are
 *   not duplicated. A retried dispatch cannot stack the persona twice.
 * - **Fail-open.** Callers wrap resolution in a try/catch and return the
 *   original request on any fault. A broken injection never breaks a chat.
 */

function textPart(text: string): ContentPart {
  return { kind: "text", text };
}

function systemTexts(request: CanonicalRequest): readonly string[] {
  return (request.system ?? [])
    .filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text);
}

function scriptMessages(entries: readonly PromptInjection[]): readonly CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const entry of entries) {
    if (entry.mode !== "script") continue;
    for (const turn of entry.turns) {
      const content = turn.content.trim();
      if (content.length === 0) continue;
      messages.push({ role: turn.role, content: [textPart(content)] });
    }
  }
  return messages;
}

/** Applies a resolved stack to one canonical request. Pure; returns the input when nothing applies. */
export function withPromptInjections(
  request: CanonicalRequest,
  injections: readonly PromptInjection[],
): CanonicalRequest {
  if (injections.length === 0) return request;
  // Embeddings carry no conversation: there is no system field and no history
  // to prime. Injecting into `embedding_input` would change what is embedded.
  if (request.embedding_input !== undefined) return request;

  const existing = systemTexts(request);
  const prepend: string[] = [];
  const append: string[] = [];
  for (const entry of injections) {
    if (entry.mode !== "prompt") continue;
    const text = entry.content.trim();
    if (text.length === 0) continue;
    if (existing.includes(text)) continue;
    const target = entry.position === "prepend" ? prepend : append;
    if (!target.includes(text)) target.push(text);
  }

  const systemParts: ContentPart[] = [
    ...prepend.map(textPart),
    ...(request.system ?? []),
    ...append.map(textPart),
  ];

  const scripted = scriptMessages(injections);
  let messages: readonly CanonicalMessage[] = request.messages;
  if (scripted.length > 0) {
    const current = [...request.messages];
    // System/developer turns lead the conversation; fake history belongs right
    // after them, before the first real user turn.
    let index = 0;
    while (index < current.length) {
      const role = current[index]?.role;
      if (role !== "system" && role !== "developer") break;
      index += 1;
    }
    const alreadyThere = scripted.every((message, offset) => {
      const candidate = current[index + offset];
      return (
        candidate !== undefined &&
        candidate.role === message.role &&
        candidate.content.length === 1 &&
        candidate.content[0]?.kind === "text" &&
        candidate.content[0].text === (message.content[0]?.kind === "text" ? message.content[0].text : "")
      );
    });
    if (!alreadyThere) {
      current.splice(index, 0, ...scripted);
      messages = current;
    }
  }

  if (prepend.length === 0 && append.length === 0 && messages === request.messages) return request;

  return {
    ...request,
    ...(systemParts.length > 0 ? { system: systemParts } : {}),
    messages,
  };
}

/** Model names a `model` injection may match, most specific first. */
export function injectionModelNames(
  request: CanonicalRequest,
  candidates: readonly { readonly provider_id: string; readonly model_id: string }[],
): readonly string[] {
  const primary = candidates[0];
  const bare = request.model.includes("/")
    ? request.model.slice(request.model.lastIndexOf("/") + 1)
    : undefined;
  const names = [
    request.model,
    primary === undefined ? undefined : `${primary.provider_id}/${primary.model_id}`,
    primary?.model_id,
    bare,
  ];
  return [...new Set(names.filter((name): name is string => typeof name === "string" && name.length > 0))];
}

/**
 * Resolves and applies the stack for one request. Any storage failure yields
 * the untouched request; this is the fail-open boundary the feature promises.
 */
export async function applyPromptInjections(
  db: LianRouterDatabase,
  request: CanonicalRequest,
  context: { readonly tenantId: string; readonly apiKeyId?: string | undefined },
  candidates: readonly { readonly provider_id: string; readonly model_id: string }[],
): Promise<CanonicalRequest> {
  try {
    const store = new DrizzlePromptInjectionStore(db);
    const injections = await store.resolve(context.tenantId, {
      ...(context.apiKeyId === undefined ? {} : { apiKeyId: context.apiKeyId }),
      modelNames: injectionModelNames(request, candidates),
    });
    return withPromptInjections(request, injections);
  } catch {
    return request;
  }
}

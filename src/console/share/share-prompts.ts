// Latest-user-prompt extraction for the share recipient view.
//
// The share detail reads the request body the tenant opted into capturing
// (`telemetryPayloads: "bounded"`), which is the client's own wire body rather
// than a canonical request. Each supported surface frames its turns
// differently, so this module owns the four shapes in one place instead of
// letting the console walk provider-specific JSON inline:
//
//   chat / messages  → `messages[].content`
//   responses        → `input` (string, or items with `content`)
//   completions      → `prompt` (string, or string[])
//
// Only text parts count. An image, audio, file, or tool-result part carries no
// prompt to show, and a tool result must never be mistaken for something the
// recipient typed. The *last* user turn is the prompt for that request: earlier
// turns are conversation context, not the message that produced this row.
import { isRecord } from "../../protocol/primitives";

/** Ceiling on one prompt rendering; the capture itself may hold far more. */
export const SHARE_PROMPT_MAX_CHARS = 4_000;

export interface ExtractedPrompt {
  readonly text: string;
  readonly truncated: boolean;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = part["type"];
    if (type !== undefined && type !== "text" && type !== "input_text") continue;
    const text = part["text"];
    if (typeof text === "string") texts.push(text);
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

function lastUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message["role"] !== "user") continue;
    const text = textFromContent(message["content"]);
    if (text !== undefined && text.trim().length > 0) return text;
  }
  return undefined;
}

function lastResponsesInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item) || item["role"] !== "user") continue;
    const text = textFromContent(item["content"]);
    if (text !== undefined && text.trim().length > 0) return text;
  }
  return undefined;
}

function lastCompletionPrompt(prompt: unknown): string | undefined {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return undefined;
  const strings = prompt.filter((entry): entry is string => typeof entry === "string");
  return strings.length === 0 ? undefined : strings[strings.length - 1];
}

/** The latest user-visible prompt in a captured ingress body, or undefined. */
export function extractPromptText(body: unknown): ExtractedPrompt | undefined {
  if (!isRecord(body)) return undefined;
  const raw =
    lastUserMessage(body["messages"]) ??
    lastResponsesInput(body["input"]) ??
    lastCompletionPrompt(body["prompt"]);
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  return text.length <= SHARE_PROMPT_MAX_CHARS
    ? { text, truncated: false }
    : { text: text.slice(0, SHARE_PROMPT_MAX_CHARS), truncated: true };
}

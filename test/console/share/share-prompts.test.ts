import { describe, expect, test } from "bun:test";
import {
  extractPromptText,
  SHARE_PROMPT_MAX_CHARS,
} from "../../../src/console/share/share-prompts";

describe("share prompt extraction", () => {
  test("takes the last user turn from chat content parts", () => {
    expect(
      extractPromptText({
        model: "gpt-5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: [{ type: "text", text: "first question" }] },
          { role: "assistant", content: "first answer" },
          { role: "user", content: [{ type: "text", text: "follow-up" }] },
        ],
      }),
    ).toEqual({ text: "follow-up", truncated: false });
  });

  test("accepts a string content body on the messages surface", () => {
    expect(
      extractPromptText({
        model: "claude-x",
        messages: [{ role: "user", content: "explain the offset drift" }],
      }),
    ).toEqual({ text: "explain the offset drift", truncated: false });
  });

  test("reads a responses input string and item list", () => {
    expect(extractPromptText({ model: "gpt-5", input: "plain input" })).toEqual({
      text: "plain input",
      truncated: false,
    });
    expect(
      extractPromptText({
        input: [
          { role: "user", content: [{ type: "input_text", text: "older" }] },
          { role: "user", content: [{ type: "input_text", text: "newer" }] },
        ],
      }),
    ).toEqual({ text: "newer", truncated: false });
  });

  test("reads the last completions prompt string", () => {
    expect(extractPromptText({ prompt: ["one", "two"] })).toEqual({
      text: "two",
      truncated: false,
    });
  });

  test("ignores non-text parts and non-user turns", () => {
    expect(
      extractPromptText({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "text", text: "what is in this image" },
            ],
          },
          { role: "assistant", content: "a screenshot" },
        ],
      }),
    ).toEqual({ text: "what is in this image", truncated: false });
    expect(
      extractPromptText({
        messages: [{ role: "tool", content: "tool output only" }],
      }),
    ).toBeUndefined();
  });

  test("returns undefined when no user text exists", () => {
    expect(extractPromptText({ messages: [] })).toBeUndefined();
    expect(extractPromptText({ messages: [{ role: "user", content: [] }] })).toBeUndefined();
    expect(extractPromptText({ model: "gpt-5" })).toBeUndefined();
    expect(extractPromptText(null)).toBeUndefined();
  });

  test("caps a long prompt and reports truncation", () => {
    const long = "x".repeat(SHARE_PROMPT_MAX_CHARS + 25);
    expect(extractPromptText({ messages: [{ role: "user", content: long }] })).toEqual({
      text: "x".repeat(SHARE_PROMPT_MAX_CHARS),
      truncated: true,
    });
  });
});

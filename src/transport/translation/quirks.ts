// Declarative provider parameter quirks.
//
// Some upstreams reject combinations the OpenAI/Anthropic contracts permit
// (e.g. Anthropic rejects `temperature` alongside extended thinking). Instead
// of scattering ad-hoc `delete payload.x` fixes through adapters, each quirk
// lives in one table row: the provider it applies to, an optional model
// matcher, and the strip/clamp to apply.
//
// Add a row ONLY when a concrete upstream 400/422 proves the quirk; do not
// speculate. The table is applied on the dispatch path before wire translation.

import type { CanonicalRequest, GenerationControls } from "../canonical-model";
import {
  THINKING_STRIPPED_SAMPLING_CONTROLS,
  isThinkingEnabled,
} from "./capabilities";

export interface ParamQuirk {
  /** Provider id the quirk applies to (matches `candidate.provider_id`). */
  readonly provider: string;
  /** Optional model-name matcher; when absent the quirk applies to every model. */
  readonly matchModel?: RegExp;
  /** Canonical `generation_controls` keys to strip before dispatch. */
  readonly stripControls?: readonly (keyof GenerationControls)[];
  /** Upper bound applied to `generation_controls.max_tokens` when exceeded. */
  readonly clampMaxOutput?: number;
}

/**
 * Confirmed quirks only.
 *
 * - Anthropic rejects `temperature` when extended thinking is active on Claude
 *   models.
 * - The Tencent buddy gateways (`cb`, `cbcn`, `workbuddy`) proxy Claude models
 *   to Anthropic, which removed the sampling parameters in Opus 4.7. A
 *   non-default `temperature`/`top_p`/`top_k` is answered with HTTP 400 "the
 *   request parameters were rejected by the model provider" — intermittently,
 *   because the gateway only forwards the field for some routes. The probe path
 *   always sets `temperature: 0.2`, so every Opus 4.7+ probe hit it eventually.
 *   Older Claude generations still accept them, so the matcher is limited to
 *   the 4.7+ ids the buddy catalogs declare.
 */
const PARAM_QUIRKS: readonly ParamQuirk[] = [
  { provider: "anthropic", matchModel: /claude/, stripControls: ["temperature"] },
  {
    provider: "cb",
    matchModel: /^claude-(?:opus-4\.[789]|opus-5|sonnet-5)/,
    stripControls: ["temperature", "top_p", "top_k"],
  },
  {
    provider: "cbcn",
    matchModel: /^claude-(?:opus-4\.[789]|opus-5|sonnet-5)/,
    stripControls: ["temperature", "top_p", "top_k"],
  },
  {
    provider: "workbuddy",
    matchModel: /^claude-(?:opus-4\.[789]|opus-5|sonnet-5)/,
    stripControls: ["temperature", "top_p", "top_k"],
  },
];

/** Finds the first quirk matching the provider/model pair, or undefined. */
export function findParamQuirk(
  providerId: string,
  modelId: string,
): ParamQuirk | undefined {
  return PARAM_QUIRKS.find(
    (quirk) =>
      quirk.provider === providerId &&
      (quirk.matchModel === undefined || quirk.matchModel.test(modelId)),
  );
}

/**
 * Applies the provider/model quirks to a canonical request, returning the
 * original reference when nothing matched (callers can compare identity).
 */
export function applyParamQuirks(
  request: CanonicalRequest,
  providerId: string,
): CanonicalRequest {
  const quirk = findParamQuirk(providerId, request.model);
  if (quirk === undefined) return request;

  let controls = request.generation_controls;
  let changed = false;

  if (quirk.stripControls !== undefined && quirk.stripControls.length > 0) {
    controls = { ...controls };
    for (const key of quirk.stripControls) {
      if (key in controls) {
        delete controls[key];
        changed = true;
      }
    }
  }

  // Extended thinking rejects sampling controls upstream. The stripped set is
  // owned by capabilities.ts (shared with the Messages payload builder, which
  // applies the same rule at translation time) — the quirks table itself
  // keeps only its declarative temperature row.
  if (isThinkingEnabled(request)) {
    for (const key of THINKING_STRIPPED_SAMPLING_CONTROLS) {
      if (key in controls) {
        if (!changed) controls = { ...controls };
        delete controls[key];
        changed = true;
      }
    }
  }

  if (quirk.clampMaxOutput !== undefined) {
    const limit = quirk.clampMaxOutput;
    if (typeof controls.max_tokens === "number" && controls.max_tokens > limit) {
      controls = { ...controls, max_tokens: limit };
      changed = true;
    }
  }

  return changed ? { ...request, generation_controls: controls } : request;
}

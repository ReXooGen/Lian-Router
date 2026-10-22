import type { ValidatedOutboundFetch } from "../provider-registry";
import { GATEWAY_USER_AGENT } from "./gateway-user-agent";

/**
 * Strips the gateway's own `LianRouter/<version>` user-agent before a probe
 * reaches the upstream, so a credential-free discovery call never leaks the
 * gateway identity. Provider-specific CLI cloaks (`opencode/`, `claude-cli/`,
 * `codex_cli_rs/`, `antigravity/`, `KimiCLI/`, …) are preserved verbatim —
 * they are the whole point of the fingerprint and the upstream's free-tier
 * gate rejects the probe without them (OpenCode Free returns 403
 * `FreeTierError` "can only be used from within OpenCode"). Only the
 * gateway's own `LianRouter/*` identity would ever leak here; the explicit
 * check keeps the strip tightly scoped to that one case.
 */
export function createProbeFetch(fetcher: ValidatedOutboundFetch): ValidatedOutboundFetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const ua = headers.get("user-agent") ?? "";
    if (ua === "" || ua === GATEWAY_USER_AGENT || ua.startsWith("LianRouter/")) {
      headers.delete("user-agent");
    }
    return fetcher(input, { ...init, headers });
  };
}

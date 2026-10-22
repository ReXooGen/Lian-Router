import { GatewayError } from "../../transport/gateway-error";
import type { ProviderDispatchContext } from "../provider-registry";

export interface UpstreamDeadlineLifecycle {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

/**
 * Message on the abort the lifecycle raises when the pre-stream budget runs
 * out. Kept in one place so the reason and the surfaced error cannot drift.
 */
export const UPSTREAM_DEADLINE_MESSAGE =
  "upstream did not start responding within the request deadline";

/**
 * The failure an abort actually represents, or `undefined` when the error is
 * not an abort at all.
 *
 * A client disconnect and the gateway's own pre-stream deadline both arrive
 * here as aborts, and conflating them told operators "request was cancelled"
 * for a request nobody cancelled — the upstream was merely slow. The deadline
 * timer therefore aborts with a `deadline_exceeded` GatewayError, and this
 * helper maps any of its shapes (GatewayError reason, the request state's
 * `TimeoutError`, or a bare `AbortError` caused by either) to the honest
 * answer. Only a real cancellation becomes `transport_closed` 499.
 */
export function abortFailure(
  signal: AbortSignal,
  error?: unknown,
): GatewayError | undefined {
  const reason: unknown = signal.reason;
  if (reason instanceof GatewayError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new GatewayError("deadline_exceeded", 504, UPSTREAM_DEADLINE_MESSAGE);
  }
  if (signal.aborted) return new GatewayError("transport_closed", 499, "request was cancelled");
  if (error instanceof Error && error.name === "AbortError") {
    return new GatewayError("transport_closed", 499, "request was cancelled");
  }
  return undefined;
}

export function createUpstreamDeadlineLifecycle(
  context: ProviderDispatchContext,
): UpstreamDeadlineLifecycle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(context.abort_signal.reason);
  const timeoutId = setTimeout(
    () =>
      controller.abort(
        new GatewayError("deadline_exceeded", 504, UPSTREAM_DEADLINE_MESSAGE),
      ),
    Math.max(0, context.deadline - Date.now()),
  );
  context.abort_signal.addEventListener("abort", onAbort, { once: true });
  if (context.abort_signal.aborted) controller.abort(context.abort_signal.reason);

  let released = false;
  return {
    signal: controller.signal,
    release: () => {
      if (released) return;
      released = true;
      clearTimeout(timeoutId);
      context.abort_signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function withUpstreamDeadline<T>(
  context: ProviderDispatchContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  try {
    return await fn(lifecycle.signal);
  } catch (error: unknown) {
    const failure = abortFailure(lifecycle.signal, error);
    if (failure) throw failure;
    throw error;
  } finally {
    lifecycle.release();
  }
}

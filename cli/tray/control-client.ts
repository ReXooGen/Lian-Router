/**
 * Typed client for the CLI's loopback control API.
 *
 * The control API is the tray's only channel into the running gateway: the tray
 * process never touches the database, the server socket, or the child process
 * table. Every method returns a discriminated result instead of throwing,
 * because a menu action that throws inside a Win32 callback unwinds through
 * native frames and takes the tray icon down with it — the operator would lose
 * the menu and keep a stale icon in the notification area until Explorer
 * restarted.
 *
 * The `x-lianrouter-control` header is the entire authorization model. The
 * control port is bound to 127.0.0.1 and any local process can reach it, so the
 * shared token from `run/control.json` is what stops an unrelated program on
 * the same machine from stopping the gateway or starting an update.
 */

const CONTROL_HEADER = "x-lianrouter-control";
const REQUEST_TIMEOUT_MS = 5000;

/** Server lifecycle states the CLI reports from `GET /status`. */
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "error";

/** Update state the CLI reports from `GET /status`. */
export interface UpdateStatus {
  readonly available: boolean;
  readonly current?: string;
  readonly latest?: string;
}

/** Body of `GET /status`. */
export interface ControlStatus {
  readonly state: ServerState;
  readonly port: number;
  readonly pid: number;
  readonly url: string;
  readonly update: UpdateStatus;
}

/** One progress frame from the update engine, as `/update/state` reports it. */
export interface UpdateProgressFrame {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly error?: string;
}

/** Durable update state kept in the launcher process; see `GET /update/state`. */
export interface UpdateStateFrame {
  readonly snapshot: UpdateStatus | null;
  readonly progress: UpdateProgressFrame | null;
  readonly running: boolean;
}

/** Result of one control call. Never throws by contract. */
export type ControlResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

/** The control client the tray menu drives. */
export interface ControlClient {
  status(): Promise<ControlResult<ControlStatus>>;
  restart(): Promise<ControlResult<unknown>>;
  stop(): Promise<ControlResult<unknown>>;
  shutdown(): Promise<ControlResult<unknown>>;
  openWeb(): Promise<ControlResult<unknown>>;
  startUpdate(): Promise<ControlResult<unknown>>;
  /** Durable update state; the tray polls this to learn how a run ended. */
  updateState(): Promise<ControlResult<UpdateStateFrame>>;
}

const SERVER_STATES: readonly ServerState[] = ["stopped", "starting", "running", "stopping", "error"];

function isServerState(value: unknown): value is ServerState {
  return typeof value === "string" && (SERVER_STATES as readonly string[]).includes(value);
}

function readUpdateStatus(value: unknown): UpdateStatus {
  if (typeof value !== "object" || value === null || !("available" in value)) return { available: false };
  const available = value.available === true;
  const current = "current" in value && typeof value.current === "string" ? value.current : undefined;
  const latest = "latest" in value && typeof value.latest === "string" ? value.latest : undefined;
  return {
    available,
    ...(current === undefined ? {} : { current }),
    ...(latest === undefined ? {} : { latest }),
  };
}

/**
 * Narrows a decoded `GET /status` body.
 *
 * A shape mismatch is a real failure, not something to paper over with
 * defaults: the tray's whole job is to show the operator the true state, and a
 * silent fallback would display "stopped" for a gateway that is serving.
 */
function readStatus(body: unknown): ControlStatus | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("state" in body) || !isServerState(body.state)) return undefined;
  if (!("port" in body) || typeof body.port !== "number") return undefined;
  if (!("pid" in body) || typeof body.pid !== "number") return undefined;
  if (!("url" in body) || typeof body.url !== "string") return undefined;
  return {
    state: body.state,
    port: body.port,
    pid: body.pid,
    url: body.url,
    update: readUpdateStatus("update" in body ? body.update : undefined),
  };
}

function readProgressFrame(value: unknown): UpdateProgressFrame | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("phase" in value) || typeof value.phase !== "string") return null;
  const percent = "percent" in value && typeof value.percent === "number" ? value.percent : 0;
  const message = "message" in value && typeof value.message === "string" ? value.message : "";
  const bytesReceived = "bytesReceived" in value && typeof value.bytesReceived === "number" ? value.bytesReceived : undefined;
  const bytesTotal = "bytesTotal" in value && typeof value.bytesTotal === "number" ? value.bytesTotal : undefined;
  const error = "error" in value && typeof value.error === "string" ? value.error : undefined;
  return {
    phase: value.phase,
    percent,
    message,
    ...(bytesReceived === undefined ? {} : { bytesReceived }),
    ...(bytesTotal === undefined ? {} : { bytesTotal }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Narrows a decoded `GET /update/state` body.
 *
 * `running` is the only field the tray's polling loop keys on, so it is the one
 * that must be exact; a body without it is rejected rather than defaulted to
 * `false`, which would report a running update as finished.
 */
function readUpdateState(body: unknown): UpdateStateFrame | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("running" in body) || typeof body.running !== "boolean") return undefined;
  const snapshot = "snapshot" in body ? body.snapshot : undefined;
  const progress = "progress" in body ? body.progress : undefined;
  return {
    snapshot: snapshot === null || snapshot === undefined ? null : readUpdateStatus(snapshot),
    progress: readProgressFrame(progress),
    running: body.running,
  };
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `The CLI did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`;
    if (error instanceof TypeError) return "Could not reach the CLI control port; it may have exited.";
    return error.message;
  }
  return String(error);
}

/** Creates a client bound to one port and control token. */
export function createControlClient(port: number, token: string): ControlClient {
  const origin = `http://127.0.0.1:${port}`;

  async function call<T>(path: string, method: "GET" | "POST", decode: (body: unknown) => T | undefined): Promise<ControlResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: { [CONTROL_HEADER]: token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, error: describeFailure(error) };
    }

    if (!response.ok) {
      // The CLI reports control failures as JSON `{ error }`; fall back to the
      // status line when a proxy or a truncated body produces something else.
      const text = await response.text().catch(() => "");
      let detail = text.trim();
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
          detail = parsed.error;
        }
      } catch {
        // Non-JSON body: the raw text is the best available detail.
      }
      return { ok: false, error: detail.length > 0 ? `${path} failed (${response.status}): ${detail}` : `${path} failed with HTTP ${response.status}` };
    }

    if (method === "POST" && response.headers.get("content-length") === "0") {
      return { ok: true, data: undefined as T };
    }
    const text = await response.text().catch(() => "");
    if (text.length === 0) return { ok: true, data: undefined as T };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: `${path} returned a body that is not JSON.` };
    }
    const decoded = decode(parsed);
    if (decoded === undefined) return { ok: false, error: `${path} returned an unexpected body shape.` };
    return { ok: true, data: decoded };
  }

  return {
    status: () => call("/status", "GET", readStatus),
    restart: () => call("/server/restart", "POST", () => undefined),
    stop: () => call("/server/stop", "POST", () => undefined),
    shutdown: () => call("/shutdown", "POST", () => undefined),
    openWeb: () => call("/open-web", "POST", () => undefined),
    startUpdate: () => call("/update/start", "POST", () => undefined),
    updateState: () => call("/update/state", "GET", readUpdateState),
  };
}

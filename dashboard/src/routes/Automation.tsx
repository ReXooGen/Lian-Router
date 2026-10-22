import { useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import { useSessionUser } from "../lib/hooks/system";

/**
 * Embedded automation control plane (GrokFarm WebUI) served by the gateway's
 * authenticated `/automation` proxy. The iframe is same-origin: the proxy
 * strips upstream frame/CSP headers and re-imposes a console-controlled CSP,
 * so the embedded document runs with this origin's authority.
 *
 * The card wrapper keeps the console chrome (sidebar, theme) around the tool.
 * Height fills the content column; the upstream app manages its own scrolling.
 */
export default function Automation(): ReactNode {
  const user = useSessionUser();
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-9 place-items-center rounded-xl border"
            style={{ background: "var(--surface-muted)", borderColor: "var(--border-subtle)" }}
          >
            <Bot size={17} />
          </span>
          <div>
            <h1 className="text-[15px] font-semibold">Automation</h1>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              Grok account farm control plane · signed in as {user.data?.username ?? "…"}
            </p>
          </div>
        </div>
        {!loaded && (
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            Loading control plane…
          </span>
        )}
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border"
        style={{ borderColor: "var(--border-subtle)", background: "var(--surface-1)" }}
      >
        <iframe
          src="/automation/"
          title="Automation control plane"
          className="size-full border-0"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}

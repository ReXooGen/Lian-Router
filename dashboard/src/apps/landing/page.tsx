import type { ReactElement } from "react";
import {
  Activity,
  ArrowRight,
  Boxes,
  Gauge,
  KeyRound,
  Layers,
  Network,
  Sparkles,
  Waypoints,
} from "lucide-react";
import { BrandMark } from "../../components/BrandMark";
import { ConstellationField } from "./ConstellationField";
import { HowItWorks } from "./HowItWorks";
import { ScrollProgress } from "./ScrollProgress";
import { useScrollReveal } from "./use-scroll-reveal";
import { useCursorLight } from "./use-cursor-light";

/**
 * Public product landing for LianRouter.
 *
 * Visual language: a floating glass pill navigation over a black canvas, then
 * sections built from one card primitive — icon and badge on the top row,
 * title, description, and a ruled meta line at the foot. Static markup only:
 * no data fetching and no backend imports, so the static SPA host can serve it
 * without a session.
 */

const CONSOLE_LOGIN_PATH = "/console/login";

type IconName = "activity" | "boxes" | "gauge" | "key" | "layers" | "network" | "waypoints";

const ICONS: Record<IconName, typeof Activity> = {
  activity: Activity,
  boxes: Boxes,
  gauge: Gauge,
  key: KeyRound,
  layers: Layers,
  network: Network,
  waypoints: Waypoints,
};

interface Panel {
  readonly id: string;
  readonly icon: IconName;
  readonly badge: string;
  readonly title: string;
  readonly description: string;
  readonly meta: string;
  readonly status: string;
}

interface Stage {
  readonly index: string;
  readonly name: string;
  readonly detail: string;
}

interface Provider {
  readonly name: string;
  readonly id: string;
}

const CAPABILITIES: readonly Panel[] = [
  {
    id: "translates",
    icon: "waypoints",
    badge: "ROUTING",
    title: "Translates instead of rejecting",
    description:
      "When a model cannot express part of a request, LianRouter adapts it in place — generation controls dropped, unsupported media replaced — rather than quietly rerouting to a model you never picked.",
    meta: "generation controls · media",
    status: "Degrades in place",
  },
  {
    id: "health",
    icon: "activity",
    badge: "HEALTH",
    title: "Accounts that rest when they should",
    description:
      "Every failure is classified as active, degraded, cooldown, or disabled, each with its own backoff. Every transition lands in a log you can read.",
    meta: "active · degraded · cooldown · disabled",
    status: "Auto recovery",
  },
  {
    id: "protocols",
    icon: "layers",
    badge: "PROTOCOLS",
    title: "Four protocols, one shape",
    description:
      "Chat Completions, Responses, Messages, and the legacy Completions API arrive as the same canonical request, so routing never depends on which client dialed in.",
    meta: "chat · responses · messages · completions",
    status: "One canonical",
  },
  {
    id: "egress",
    icon: "network",
    badge: "EGRESS",
    title: "Egress that cannot leak",
    description:
      "HTTP CONNECT, HTTPS CONNECT, and SOCKS5 pools are SSRF-validated when you create them and again when they connect. A pool that is down fails the request — it never quietly goes direct.",
    meta: "http connect · https connect · socks5",
    status: "SSRF validated",
  },
  {
    id: "tenancy",
    icon: "key",
    badge: "TENANCY",
    title: "Tenant isolation by default",
    description:
      "Scoped API keys, share links that enroll one child key per trusted client IP, per-model allow and deny policies, and rate plus token budgets on every key.",
    meta: "scoped keys · share links · budgets",
    status: "Per tenant",
  },
  {
    id: "telemetry",
    icon: "gauge",
    badge: "TELEMETRY",
    title: "Telemetry you can act on",
    description:
      "Each request is recorded with bounded, redacted payload capture, alongside Prometheus metrics, a live console log, and JSON export and import for moving a deployment.",
    meta: "metrics · payloads · export",
    status: "Prometheus",
  },
];

const STAGES: readonly Stage[] = [
  { index: "01", name: "ingress", detail: "Body read once." },
  { index: "02", name: "pipeline", detail: "Identity, abuse, auth, parse." },
  { index: "03", name: "plan", detail: "Alias, combo, capability." },
  { index: "04", name: "leases", detail: "Admission, slot, reservation." },
  { index: "05", name: "dispatch", detail: "Stream primed before 200." },
  { index: "06", name: "settle", detail: "Usage, health, telemetry." },
];

const PROVIDERS: readonly Provider[] = [
  { name: "OpenAI", id: "openai" },
  { name: "Anthropic", id: "anthropic" },
  { name: "Codex", id: "codex" },
  { name: "Gemini", id: "gemini" },
  { name: "Grok", id: "grok" },
  { name: "Cursor", id: "cursor" },
  { name: "Devin", id: "devin" },
  { name: "Mistral", id: "mistral" },
  { name: "Groq", id: "groq" },
  { name: "OpenRouter", id: "openrouter" },
  { name: "Cerebras", id: "cerebras" },
  { name: "NVIDIA", id: "nvidia" },
  { name: "Cloudflare", id: "cloudflare" },
  { name: "DeepSeek", id: "deepseek" },
  { name: "Qwen", id: "qwen" },
  { name: "Kimi", id: "kimi" },
  { name: "Zai", id: "zai" },
  { name: "Ollama", id: "ollama" },
];

const SETUP: readonly Panel[] = [
  {
    id: "client",
    icon: "boxes",
    badge: "CLIENT",
    title: "Point a client at one URL",
    description:
      "Claude Code, Codex, Cursor, or any OpenAI-compatible client keeps its own wire format and talks to the same base URL.",
    meta: "claude code · codex · cursor",
    status: "No rewrite",
  },
  {
    id: "accounts",
    icon: "key",
    badge: "ACCOUNTS",
    title: "Connect your accounts",
    description:
      "Attach credentials for the providers you already pay for. Each account keeps its own authentication and identity headers.",
    meta: "api key · oauth",
    status: "Encrypted at rest",
  },
  {
    id: "mapping",
    icon: "waypoints",
    badge: "ROUTING",
    title: "Decide what serves what",
    description:
      "Aliases, combos, and CLI-tool mappings choose the account behind a model, with capability checks applied first.",
    meta: "aliases · combos · cli maps",
    status: "Capability checked",
  },
  {
    id: "runtime",
    icon: "activity",
    badge: "RUNTIME",
    title: "Let it run",
    description:
      "Failures fail over, exhausted accounts cool down, and every request is recorded with the account that served it.",
    meta: "failover · cooldown · telemetry",
    status: "Always on",
  },
];

function PanelCard({ panel }: { readonly panel: Panel }): ReactElement {
  const Icon = ICONS[panel.icon];
  const reveal = useScrollReveal<HTMLElement>();
  const light = useCursorLight<HTMLElement>();
  return (
    <article
      ref={(node) => {
        reveal.ref.current = node;
        light.ref.current = node;
      }}
      className={`lr-card ${reveal.className}`}
    >
      <div className="lr-card-top">
        <span className="lr-card-icon" aria-hidden={true}>
          <Icon size={17} />
        </span>
        <span className="lr-badge">{panel.badge}</span>
      </div>
      <h3 className="lr-card-title">{panel.title}</h3>
      <p className="lr-card-body">{panel.description}</p>
      <div className="lr-card-meta">
        <span>{panel.meta}</span>
        <span className="lr-card-status">{panel.status}</span>
      </div>
    </article>
  );
}

export function LandingPage(): ReactElement {
  const pipelineLight = useCursorLight<HTMLOListElement>();
  const providerLight = useCursorLight<HTMLDivElement>();
  const finalLight = useCursorLight<HTMLDivElement>();
  return (
    <div className="lr" id="top">
      <ConstellationField />
      <ScrollProgress />
      <div className="lr-navwrap">
        <header className="lr-nav-pill">
          <a className="lr-brand" href="#top">
            <span className="lr-brand-mark">
              <BrandMark />
            </span>
            <span className="lr-brand-name">LianRouter</span>
          </a>
          <nav className="lr-nav" aria-label="Primary navigation">
            <a href="#how">How it works</a>
            <a href="#capabilities">Capabilities</a>
            <a href="#pipeline">Pipeline</a>
            <a href="#providers">Providers</a>
            <a href="#setup">Setup</a>
            <a href="/status">Status</a>
          </nav>
          <a className="lr-nav-cta" href={CONSOLE_LOGIN_PATH}>
            <ArrowRight size={14} aria-hidden={true} />
            Enter console
          </a>
        </header>
      </div>

      <main>
        <section className="lr-hero">
          <div className="lr-shell lr-hero-grid">
            <div className="lr-hero-copy">
              <p className="lr-eyebrow">Self-hosted AI gateway</p>
              <h1 className="lr-hero-title">
                Every client. Every provider.
                <br />
                One door.
              </h1>
              <p className="lr-hero-lede">
                LianRouter takes the request formats your tools already send, folds them into a
                single canonical shape, and hands each one to the provider account that can
                actually serve it — under health tracking, capability checks, and validated
                egress.
              </p>
              <div className="lr-hero-actions">
                <a className="lr-cta" href={CONSOLE_LOGIN_PATH}>
                  Open the console
                  <ArrowRight size={14} aria-hidden={true} />
                </a>
              </div>
            </div>
          </div>
        </section>

        <HowItWorks />

        <section className="lr-section" id="capabilities">
          <div className="lr-shell">
            <p className="lr-eyebrow">Capabilities</p>
            <h2 className="lr-heading">The hard part happens after the request lands.</h2>
            <p className="lr-sub">
              Admission, retries, accounting, and telemetry are shared by every surface. A
              Messages call and a Chat Completions call take the same path once they are
              canonical.
            </p>
            <div className="lr-grid">
              {CAPABILITIES.map((panel) => (
                <PanelCard key={panel.id} panel={panel} />
              ))}
            </div>
          </div>
        </section>

        <section className="lr-section" id="pipeline">
          <div className="lr-shell">
            <p className="lr-eyebrow">Request path</p>
            <h2 className="lr-heading">Six steps, identical for every surface.</h2>
            <ol className="lr-stages lr-card" ref={pipelineLight.ref}>
              {STAGES.map((stage) => (
                <li className="lr-stage" key={stage.index}>
                  <span className="lr-stage-index">{stage.index}</span>
                  <span className="lr-stage-name">{stage.name}</span>
                  <span className="lr-stage-detail">{stage.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="lr-section" id="providers">
          <div className="lr-shell">
            <p className="lr-eyebrow">Providers</p>
            <h2 className="lr-heading">Forty integrations behind one endpoint.</h2>
            <div className="lr-card lr-providercard" ref={providerLight.ref}>
              <ul className="lr-providers">
                {PROVIDERS.map((provider) => (
                  <li className="lr-provider" key={provider.id}>
                    <span className="lr-provider-name">{provider.name}</span>
                    <span className="lr-provider-id">{provider.id}</span>
                  </li>
                ))}
              </ul>
              <div className="lr-card-meta">
                <span>+22 more bundled integrations</span>
                <span className="lr-card-status">All in one catalog</span>
              </div>
            </div>
          </div>
        </section>

        <section className="lr-section" id="setup">
          <div className="lr-shell">
            <p className="lr-eyebrow">Setup</p>
            <h2 className="lr-heading">From zero to routed.</h2>
            <div className="lr-grid lr-grid--pair">
              {SETUP.map((panel) => (
                <PanelCard key={panel.id} panel={panel} />
              ))}
            </div>
          </div>
        </section>

        <section className="lr-section lr-section--end">
          <div className="lr-shell">
            <div className="lr-card lr-final" ref={finalLight.ref}>
              <div className="lr-final-copy">
                <p className="lr-eyebrow">Start here</p>
                <h2>One endpoint. One key. One dashboard.</h2>
                <p className="lr-sub">
                  Self-hosted on Bun, TypeScript, Elysia, and PostgreSQL. Sign in and connect your
                  first provider account.
                </p>
              </div>
              <div className="lr-final-side">
                <a className="lr-cta" href={CONSOLE_LOGIN_PATH}>
                  Open the console
                  <ArrowRight size={14} aria-hidden={true} />
                </a>
                <code className="lr-final-url">
                  /v1/chat/completions · /v1/messages · /v1/responses
                </code>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lr-foot">
        <div className="lr-shell lr-foot-inner">
          <span className="lr-foot-brand">
            <Sparkles size={12} aria-hidden={true} />
            LianRouter
          </span>
          <span>self-hosted AI gateway</span>
          <a href="/status">status</a>
          <a href={CONSOLE_LOGIN_PATH}>console</a>
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;

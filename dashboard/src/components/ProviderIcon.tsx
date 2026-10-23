import { memo, useState } from "react";

const failedIcons = new Set<string>();

const iconAssets: Record<string, { file: string; ext: "svg" | "webp" }> = {
  claude: { file: "claude-code", ext: "svg" },
  anthropic: { file: "anthropic-light", ext: "svg" },
  openai: { file: "openai-light", ext: "svg" },
  codex: { file: "codex", ext: "webp" },
  opencode: { file: "opencode", ext: "webp" },
  opencodeft: { file: "opencode", ext: "webp" },
  opencodezen: { file: "opencode", ext: "webp" },
  opencodego: { file: "opencode-go", ext: "webp" },
  "google-antigravity": { file: "antigravity", ext: "svg" },
  antigravity: { file: "antigravity", ext: "svg" },
  blackbox: { file: "blackbox", ext: "svg" },
  blackboxai: { file: "blackbox", ext: "svg" },
  grok: { file: "grok-build", ext: "webp" },
  "grok-build": { file: "grok-build", ext: "webp" },
  browseruse: { file: "browseruse", ext: "webp" },
  gemini: { file: "gemini", ext: "webp" },
  // Vertex serves the Gemini family and ships no separate brand mark in this
  // repo, so it reuses the Gemini asset rather than pointing at a missing file.
  vertex: { file: "gemini", ext: "webp" },
  "gemini-cli": { file: "gemini-cli", ext: "webp" },
  groq: { file: "groq", ext: "webp" },
  alibaba: { file: "alibaba", ext: "svg" },
  alibabacp: { file: "alibaba-coding-plan", ext: "svg" },
  fireworks: { file: "fireworks", ext: "webp" },
  cloudflare: { file: "cloudflare", ext: "webp" },
  exa: { file: "exa", ext: "svg" },
  perplexity: { file: "perplexity", ext: "webp" },
  tokenharbor: { file: "tokenharbor", ext: "svg" },
  aihubmix: { file: "aihubmix", ext: "svg" },
  zai: { file: "zai", ext: "svg" },
  zaicp: { file: "zai-coding-plan", ext: "svg" },
  "kimi-code": { file: "kimi-code", ext: "webp" },
  kimi: { file: "kimi-code", ext: "webp" },
  github: { file: "github", ext: "webp" },
  copilot: { file: "copilot", ext: "webp" },
  xiaomipg: { file: "mimo", ext: "webp" },
  xiaomitp: { file: "mimo", ext: "webp" },
  mimo: { file: "mimo", ext: "webp" },
  cb: { file: "codebuddy", ext: "webp" },
  cbcn: { file: "codebuddy", ext: "webp" },
  // The buddy-family gateways share one brand mark, so WorkBuddy reuses it the
  // same way cbcn does. Without this entry `assetFor` fell through to
  // `workbuddy.webp`, which does not exist, and every WorkBuddy row rendered
  // the initials fallback instead of a logo.
  workbuddy: { file: "codebuddy", ext: "webp" },
  agentrouter: { file: "agentrouter", ext: "svg" },
  "devin-search": { file: "devin-search", ext: "svg" },
  devin: { file: "devin", ext: "webp" },
  parallel: { file: "parallel", ext: "svg" },
  gmi: { file: "gmi-cloud", ext: "svg" },
  hermes: { file: "hermes", ext: "webp" },
  nous: { file: "nous-research", ext: "svg" },
  bai: { file: "bai", ext: "svg" },
  cline: { file: "cline", ext: "webp" },
  cerebras: { file: "cerebras", ext: "webp" },
  qoder: { file: "qoder", ext: "webp" },
  // Same vendor mark as the international product on a China host.
  "qoder-cn": { file: "qoder", ext: "webp" },
  mistral: { file: "mistral", ext: "webp" },
  muse: { file: "muse", ext: "svg" },
  openrouter: { file: "openrouter", ext: "webp" },
  ollama: { file: "ollama", ext: "webp" },
  ollamacloud: { file: "ollama-cloud", ext: "webp" },
  siliconflow: { file: "siliconflow", ext: "webp" },
  nvidia: { file: "nvidia", ext: "webp" },
  deepseek: { file: "deepseek", ext: "webp" },
  "deepseek-tui": { file: "deepseek-tui", ext: "webp" },
  droid: { file: "droid", ext: "webp" },
  jcode: { file: "jcode", ext: "webp" },
  kilo: { file: "kilocode", ext: "webp" },
  "kilo-gateway": { file: "kilocode-gateway", ext: "webp" },
  openclaw: { file: "openclaw", ext: "webp" },
  cowork: { file: "claude", ext: "webp" },
  cursor: { file: "cursor", ext: "webp" },
  roo: { file: "roo", ext: "webp" },
  continue: { file: "continue", ext: "webp" },
  amp: { file: "amp", ext: "webp" },
  qwen: { file: "qwen", ext: "webp" },
  kiro: { file: "kiro", ext: "webp" },
  kimchi: { file: "kimchi", ext: "webp" },
  commandcode: { file: "commandcode", ext: "webp" },
  alicode: { file: "alicode", ext: "webp" },
  "alicode-intl": { file: "alicode-intl", ext: "webp" },
  "alims-intl": { file: "alims-intl", ext: "webp" },
  "alitp-intl": { file: "alitp-intl", ext: "webp" },
  agnes: { file: "agnes", ext: "webp" },
  "api-airforce": { file: "api-airforce", ext: "webp" },
  atria: { file: "atria", ext: "webp" },
  baidu: { file: "baidu", ext: "webp" },
  bazaarlink: { file: "bazaarlink", ext: "webp" },
  byteplus: { file: "byteplus", ext: "webp" },
  chutes: { file: "chutes", ext: "webp" },
  clinepass: { file: "clinepass", ext: "webp" },
  cohere: { file: "cohere", ext: "webp" },
  bluesminds: { file: "bluesminds", ext: "webp" },
  dahl: { file: "dahl", ext: "webp" },
  featherless: { file: "featherless", ext: "webp" },
  "glm-cn": { file: "glm-cn", ext: "webp" },
  hyperbolic: { file: "hyperbolic", ext: "webp" },
  iflow: { file: "iflow", ext: "webp" },
  kilocode: { file: "kilocode", ext: "webp" },
  llm7: { file: "llm7", ext: "webp" },
  minimax: { file: "minimax", ext: "webp" },
  "minimax-cn": { file: "minimax-cn", ext: "webp" },
  "minimax-code": { file: "minimax-code", ext: "webp" },
  morph: { file: "morph", ext: "webp" },
  nebius: { file: "nebius", ext: "webp" },
  "perplexity-agent": { file: "perplexity-agent", ext: "webp" },
  sambanova: { file: "sambanova", ext: "webp" },
  poolside: { file: "poolside", ext: "webp" },
  tencent: { file: "tencent", ext: "webp" },
  together: { file: "together", ext: "webp" },
  tokenrouter: { file: "tokenrouter", ext: "webp" },
  venice: { file: "venice", ext: "webp" },
  "vercel-ai-gateway": { file: "vercel-ai-gateway", ext: "webp" },
  "volcengine-ark": { file: "volcengine-ark", ext: "webp" },
  xai: { file: "xai", ext: "webp" },
  // Both MiniMax Code gateways ship the MiniMax brand mark.
  "minimax-code-global": { file: "minimax-code", ext: "webp" },
  azure: { file: "azure", ext: "svg" },
  gitlab: { file: "gitlab", ext: "svg" },
  // Both MiMo free rows are the Xiaomi MiMo brand on the same host.
  "mimo-free": { file: "mimo-free", ext: "webp" },
  mmf: { file: "mimo-free", ext: "webp" },
  // Partner models are served by Vertex, which itself reuses the Gemini mark.
  "vertex-partner": { file: "gemini", ext: "webp" },
  zed: { file: "zed", ext: "svg" },
};

function assetFor(icon: string): { file: string; ext: "svg" | "webp" } {
  const normalized = icon.toLowerCase().trim();
  return iconAssets[normalized] ?? { file: normalized, ext: "webp" };
}

function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export const ProviderIcon = memo(function ProviderIcon({
  icon,
  name,
  size = 32,
  style,
  className,
}: {
  icon: string;
  name: string;
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [failed, setFailed] = useState(() => failedIcons.has(icon));
  const asset = assetFor(icon);
  return (
    <div
      className={className}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "8px",
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        overflow: "hidden",
        border: "1px solid var(--inner-border)",
        ...style,
      }}
      role="img"
      aria-label={`${name} provider`}
    >
      {failed ? (
        <span
          style={{
            fontSize: `${Math.max(10, Math.floor(size * 0.35))}px`,
            fontWeight: 700,
            color: "var(--text-secondary)",
          }}
        >
          {initialsOf(name)}
        </span>
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}providers/${asset.file}.${asset.ext}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "contain", padding: asset.ext === "svg" ? "1px" : "2px" }}
          onError={() => {
            failedIcons.add(icon);
            setFailed(true);
          }}
        />
      )}
    </div>
  );
});

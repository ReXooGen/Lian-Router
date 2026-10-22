/**
 * Hand-rolled Prometheus text-format registry (Requirement: no new dependency).
 * A module-level singleton (`metrics`) mirrors the existing `getDb`/`getRedis`
 * singleton pattern. Callers obtain pre-registered families as named
 * properties; `render()` emits the Prometheus exposition format on demand.
 */

export type MetricLabels = Readonly<Record<string, string | number>>;

export interface CounterMetric {
  inc(value?: number, labels?: MetricLabels): void;
}

export interface GaugeMetric extends CounterMetric {
  set(value: number, labels?: MetricLabels): void;
  dec(value?: number, labels?: MetricLabels): void;
}

export interface HistogramMetric {
  observe(value: number, labels?: MetricLabels): void;
}

function escapeLabelValue(value: string | number): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function serializeLabels(labelNames: readonly string[], labels: MetricLabels | undefined): string {
  return labelNames.map((name) => String(labels?.[name] ?? "")).join("\u0001");
}

function renderLabelSet(labelNames: readonly string[], labels: MetricLabels): string {
  if (labelNames.length === 0) return "";
  const parts = labelNames.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

// Cardinality guards prevent unbounded label expansion from untrusted input
// such as attacker-controlled status and reason values from exhausting memory.
export const MAX_SERIES = 100;
export const MAX_LABELS = 8;
export const MAX_LABEL_VALUE_LENGTH = 64;

/** Sanitize and truncate labels to guard cardinality and memory. */
export function normalizeLabels(
  labels: MetricLabels | undefined,
  labelNames: readonly string[],
): MetricLabels {
  if (!labels || labelNames.length === 0) return {};
  const out: Record<string, string> = {};
  let kept = 0;
  for (const name of labelNames) {
    if (kept >= MAX_LABELS) break;
    const raw = labels[name];
    if (raw === undefined) {
      out[name] = "";
      kept += 1;
      continue;
    }
    let value = String(raw).replace(/[\n\r"]/g, "_");
    if (value.length > MAX_LABEL_VALUE_LENGTH) value = value.slice(0, MAX_LABEL_VALUE_LENGTH);
    // Trim whitespace and collapse empty to placeholder to keep key stable.
    value = value.trim();
    out[name] = value;
    kept += 1;
  }
  return out;
}

/** True if a new series key may be added without exceeding MAX_SERIES. */
function canAddSeries(series: Map<string, unknown>, key: string): boolean {
  if (series.has(key)) return true;
  return series.size < MAX_SERIES;
}

/**
 * Shared storage, cardinality guard, and exposition rendering for the scalar
 * families. Counter and Gauge differ only in the Prometheus type word they
 * emit; the sample store, label normalization, series guard, and `inc`
 * accumulation are identical, so both extend this base to keep the wire format
 * single-sourced.
 */
abstract class ScalarMetric {
  private readonly samples = new Map<string, { labels: MetricLabels; value: number }>();

  /** The Prometheus type word emitted on the `# TYPE` line. */
  protected abstract readonly metricType: string;

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {
    if (labelNames.length > MAX_LABELS) {
      throw new Error(`metric ${name}: too many label names ${labelNames.length} > ${MAX_LABELS}`);
    }
  }

  inc(value = 1, labels?: MetricLabels): void {
    const normalized = normalizeLabels(labels, this.labelNames);
    const key = serializeLabels(this.labelNames, normalized);
    if (!canAddSeries(this.samples, key)) return;
    const previous = this.samples.get(key);
    this.samples.set(key, {
      labels: normalized,
      value: (previous?.value ?? 0) + value,
    });
  }

  /** Absolute assignment for gauge semantics, guarded like `inc`. */
  protected setSample(value: number, labels?: MetricLabels): void {
    const normalized = normalizeLabels(labels, this.labelNames);
    const key = serializeLabels(this.labelNames, normalized);
    if (!canAddSeries(this.samples, key)) return;
    this.samples.set(key, { labels: normalized, value });
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.metricType}`,
    ];
    for (const sample of this.samples.values()) {
      lines.push(`${this.name}${renderLabelSet(this.labelNames, sample.labels)} ${sample.value}`);
    }
    return lines;
  }
}

class Counter extends ScalarMetric implements CounterMetric {
  protected readonly metricType = "counter";
}

class Gauge extends ScalarMetric implements GaugeMetric {
  protected readonly metricType = "gauge";

  set(value: number, labels?: MetricLabels): void {
    this.setSample(value, labels);
  }

  dec(value = 1, labels?: MetricLabels): void {
    this.inc(-value, labels);
  }
}

class Histogram implements HistogramMetric {
  private sum = 0;
  private count = 0;
  private readonly bucketCounts: number[];

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
  ) {
    this.bucketCounts = buckets.map(() => 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    for (let index = 0; index < this.buckets.length; index += 1) {
      const bucket = this.buckets[index];
      if (bucket !== undefined && value <= bucket) this.bucketCounts[index]! += 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (let index = 0; index < this.buckets.length; index += 1) {
      const bucket = this.buckets[index];
      if (bucket === undefined) continue;
      lines.push(
        `${this.name}_bucket{le="${escapeLabelValue(bucket)}"} ${this.bucketCounts[index] ?? 0}`,
      );
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines;
  }
}

interface RenderableMetric {
  render(): string[];
}

const REQUEST_LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
const ADAPTER_LOAD_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;

export class PrometheusRegistry {
  readonly lianrouter_pg_pool_total: GaugeMetric;
  readonly lianrouter_pg_pool_idle: GaugeMetric;
  readonly lianrouter_pg_pool_waiting: GaugeMetric;
  readonly lianrouter_redis_up: GaugeMetric;
  readonly proxy_requests_total: CounterMetric;
  readonly proxy_admission_total: CounterMetric;
  readonly proxy_in_flight: GaugeMetric;
  readonly proxy_request_latency_ms: HistogramMetric;
  readonly lianrouter_telemetry_buffered: GaugeMetric;
  readonly lianrouter_telemetry_dropped_total: CounterMetric;
  readonly lianrouter_memory_rss_bytes: GaugeMetric;
  readonly lianrouter_memory_heap_used_bytes: GaugeMetric;
  readonly lianrouter_memory_heap_total_bytes: GaugeMetric;
  readonly lianrouter_memory_limit_bytes: GaugeMetric;
  readonly lianrouter_routing_roundrobin_entries: GaugeMetric;
  readonly lianrouter_ip_abuse_keys: GaugeMetric;
  readonly lianrouter_quota_cache_entries: GaugeMetric;
  readonly lianrouter_pool_agent_entries: GaugeMetric;
  readonly lianrouter_proxy_dial_dns_fallback_total: CounterMetric;
  readonly proxy_provider_adapter_load_ms: HistogramMetric;
  readonly pool_cooldown_record_failed: CounterMetric;
  readonly quota_cache_invalidate_failed: CounterMetric;
  readonly version_discovery_failed: CounterMetric;

  private readonly all: RenderableMetric[] = [];

  constructor() {
    this.lianrouter_pg_pool_total = this.gauge(
      "lianrouter_pg_pool_total",
      "Total connections in the Postgres pool",
    );
    this.lianrouter_pg_pool_idle = this.gauge(
      "lianrouter_pg_pool_idle",
      "Idle connections in the Postgres pool",
    );
    this.lianrouter_pg_pool_waiting = this.gauge(
      "lianrouter_pg_pool_waiting",
      "Clients waiting for a Postgres pool connection",
    );
    this.lianrouter_redis_up = this.gauge("lianrouter_redis_up", "Redis connectivity (1 = ready)");
    this.proxy_requests_total = this.counter(
      "proxy_requests_total",
      "Completed proxy requests by outcome status",
      ["status"],
    );
    this.proxy_admission_total = this.counter(
      "proxy_admission_total",
      "Admission decisions by reason",
      ["reason"],
    );
    this.proxy_in_flight = this.gauge(
      "proxy_in_flight",
      "Proxy requests currently executing",
    );
    this.proxy_request_latency_ms = this.histogram(
      "proxy_request_latency_ms",
      "Request latency in milliseconds",
      REQUEST_LATENCY_BUCKETS,
    );
    this.lianrouter_telemetry_buffered = this.gauge(
      "lianrouter_telemetry_buffered",
      "Telemetry events waiting to be flushed",
    );
    this.lianrouter_telemetry_dropped_total = this.counter(
      "lianrouter_telemetry_dropped_total",
      "Telemetry events dropped because the buffer was full",
    );
    this.lianrouter_memory_rss_bytes = this.gauge(
      "lianrouter_memory_rss_bytes",
      "Resident set size of the process in bytes",
    );
    this.lianrouter_memory_heap_used_bytes = this.gauge(
      "lianrouter_memory_heap_used_bytes",
      "JavaScript heap used in bytes",
    );
    this.lianrouter_memory_heap_total_bytes = this.gauge(
      "lianrouter_memory_heap_total_bytes",
      "JavaScript heap reserved in bytes",
    );
    this.lianrouter_memory_limit_bytes = this.gauge(
      "lianrouter_memory_limit_bytes",
      "Container/cgroup memory limit in bytes (0 when unknown)",
    );
    this.lianrouter_routing_roundrobin_entries = this.gauge(
      "lianrouter_routing_roundrobin_entries",
      "Round-robin routing state entries by scope",
      ["scope"],
    );
    this.lianrouter_ip_abuse_keys = this.gauge(
      "lianrouter_ip_abuse_keys",
      "Tracked keys in the in-memory IP abuse store (0 when Redis-backed)",
    );
    this.lianrouter_quota_cache_entries = this.gauge(
      "lianrouter_quota_cache_entries",
      "Entries in the in-process provider quota cache",
    );
    this.lianrouter_pool_agent_entries = this.gauge(
      "lianrouter_pool_agent_entries",
      "Cached per-pool egress agents",
    );
    this.lianrouter_proxy_dial_dns_fallback_total = this.counter(
      "lianrouter_proxy_dial_dns_fallback_total",
      "Pool/relay-bound dials whose local DNS resolution failed and were downgraded to proxy-resolved egress",
    );
    this.proxy_provider_adapter_load_ms = this.histogram(
      "proxy_provider_adapter_load_ms",
      "Time to load a provider adapter on first use",
      ADAPTER_LOAD_BUCKETS,
    );
    this.pool_cooldown_record_failed = this.counter(
      "pool_cooldown_record_failed",
      "Pool cooldown writes that failed after a provider rate limit",
    );
    this.quota_cache_invalidate_failed = this.counter(
      "quota_cache_invalidate_failed",
      "Quota cache invalidations that failed",
    );
    this.version_discovery_failed = this.counter(
      "version_discovery_failed",
      "Client version discoveries that failed, leaving the pinned fallback in use",
      ["provider"],
    );
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): CounterMetric {
    const metric = new Counter(name, help, labelNames);
    this.all.push(metric);
    return metric;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): GaugeMetric {
    const metric = new Gauge(name, help, labelNames);
    this.all.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets: readonly number[]): HistogramMetric {
    const metric = new Histogram(name, help, buckets);
    this.all.push(metric);
    return metric;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.all) lines.push(...metric.render());
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new PrometheusRegistry();

/*
 * Tokdash demo — synthetic backend
 * ---------------------------------
 * The real Tokdash app reads usage data from a local FastAPI server. This file
 * patches `window.fetch` so the unmodified frontend can run as a static site
 * (GitHub Pages) against deterministic, fully synthetic data.
 *
 * Routes mocked (must match src/tokdash/api.py):
 *   GET  /api/usage     ?period=… | ?date_from=…&date_to=…
 *   GET  /api/sessions  ?tool=<every session tool the Sessions tab has a panel for>
 *                       (&period=… | &date_from/to)
 *                       (&include_review_sessions=true|false — codex only)
 *   GET  /api/session   ?tool=…&session_id=…
 *   GET  /api/active-time  ?period=… | ?date_from=…&date_to=… (Overview agent-time KPI)
 *   GET  /api/activity-insights  (Profile Activity codex insights)
 *   GET  /api/insights  ?period=…&facets=… (Report tab)
 *   GET  /api/quota     (Quota tab, one payload per fleet machine)
 *   GET  /api/openclaw  ?period=… (OpenClaw panel on Overview)
 *   GET  /api/tools     (installed-client probe; the demo reports none)
 *   GET  /api/version   (runtime_version "demo": this build runs no update check)
 *   GET  /api/csrf-token, PUT /api/pricing-db (no-op — the demo cannot persist)
 *   GET  /health                  (fleet fingerprint: service=tokdash)
 *
 * Multi-server: the demo ships a three-machine fleet (see SERVER_FLEET below).
 * Every generated session belongs to exactly one machine, so per-server cards,
 * the combined totals and the comparison table aggregate the same rows.
 *
 * Supported sources: codex, claude_code, opencode, gemini, grok, antigravity_cli,
 *                    kimi, openclaw, pi_agent, copilot_cli, hermes, mimo, dsh,
 *                    reasonix, zcode, workbuddy, qoder, qoder_cli, omp, kilocode,
 *                    cline, zed, qwen_code, crush, muse
 * Kept off the demo on purpose: amp (a real parser, not a client the landing page
 * advertises) and cursor (a frontend brand entry with no parser behind it).
 */
(function () {
  "use strict";

  // ---------- Seeded RNG (Mulberry32) for deterministic output ----------
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0x70B05A1); // anything stable

  // ---------- Mock Quota Tracking State & Generators ----------
  // Provider and bucket shapes are declared once here; each fleet machine chooses
  // which providers it reports and may override the plan or the used percentage
  // (SERVER_FLEET[].quota). Quota stays grouped per server in the UI, so a laptop
  // with only a Claude plan and a build box with only Codex read differently.
  const QUOTA_CATALOG = {
    codex: {
      source: "codex_api",
      plan: "Pro Lite",
      buckets: [
        { bucket: "5h", label: "5-hour window", used: 34.5, resetSeconds: 6 * 3600, drift: 1.2 },
        { bucket: "7d", label: "7-day window", used: 41.2, resetSeconds: 76 * 3600, drift: 0.9 },
        { bucket: "spark_5h", label: "GPT-5.3-Codex-Spark \u00b7 5-hour", used: 21.0, resetSeconds: 7 * 3600, drift: 1.45 },
        { bucket: "spark_7d", label: "GPT-5.3-Codex-Spark \u00b7 7-day", used: 38.0, resetSeconds: 124 * 3600, drift: 0.65 },
      ],
      resetCredits: { available: 4, expiresInDays: [10, 15, 17, 30] },
    },
    claude: {
      source: "claude_api",
      plan: "Pro",
      buckets: [
        { bucket: "session", label: "Session", used: 72.1, resetSeconds: 4 * 3600, drift: 2.5 },
        { bucket: "weekly_all", label: "Weekly All", used: 54.8, resetSeconds: 100 * 3600, drift: 1.8 },
      ],
    },
    antigravity: {
      source: "antigravity_api",
      plan: null,
      buckets: [
        { bucket: "gemini-2.0-flash", label: "gemini-2.0-flash", used: 15.0, resetSeconds: 4.5 * 3600, drift: 0.8 },
        { bucket: "claude-3-5-sonnet", label: "claude-3-5-sonnet", used: 45.0, resetSeconds: 4.5 * 3600, drift: 1.7 },
      ],
    },
    minimax: {
      source: "minimax_api",
      plan: "Token Plan",
      buckets: [{ bucket: "standard", label: "Standard", used: 28.0, resetSeconds: 28 * 3600, drift: 1.1 }],
    },
    kimi: {
      source: "kimi_api",
      plan: "Coding Plan",
      buckets: [{ bucket: "coding", label: "Coding", used: 52.0, resetSeconds: 172 * 3600, drift: 1.5 }],
    },
    grok: {
      source: "grok_api",
      plan: "Build",
      buckets: [{ bucket: "build", label: "Build", used: 18.5, resetSeconds: 76 * 3600, drift: 0.95 }],
    },
    zai: {
      source: "zai_api",
      plan: "Standard",
      buckets: [
        { bucket: "5h", label: "5-hour window", used: 34.0, resetSeconds: 4 * 3600, drift: 1.3 },
        { bucket: "7d", label: "Weekly", used: 61.0, resetSeconds: 124 * 3600, drift: 1.05 },
      ],
    },
    // Mirrors src/tokdash/sources/quota/opencode_go.py: one account, three
    // windows, plan "Go", account label "default".
    opencode_go: {
      source: "opencode_go_api",
      plan: "Go",
      buckets: [
        { bucket: "rolling", label: "Rolling (5h)", used: 26.5, resetSeconds: 4.5 * 3600, drift: 1.15 },
        { bucket: "weekly", label: "Weekly", used: 44.0, resetSeconds: 96 * 3600, drift: 1.0 },
        { bucket: "monthly", label: "Monthly", used: 19.5, resetSeconds: 500 * 3600, drift: 0.5 },
      ],
    },
  };

  let quotaTrackingEnabled = true;
  let quotaConsent = {
    codex_api: true,
    claude_api: true,
    antigravity_api: true,
    minimax_api: true,
    kimi_api: true,
    grok_api: true,
    zai_api: true,
    opencode_go_api: true
  };
  let quotaPollIntervalMinutes = 15;
  // Each machine polls on its own cadence, which is what the per-server
  // "last run" line on the Quota tab is meant to show.
  const quotaLastRunByServer = new Map();

  function quotaLastRunFor(server) {
    if (!quotaLastRunByServer.has(server.id)) {
      quotaLastRunByServer.set(
        server.id,
        Math.floor((Date.now() - (server.quotaLastRunMinutesAgo || 8) * 60 * 1000) / 1000)
      );
    }
    return quotaLastRunByServer.get(server.id);
  }

  function serverQuotaKeys(server) {
    return Object.keys(server.quota || {}).filter((key) => QUOTA_CATALOG[key]);
  }

  function quotaProviderPayload(server, key) {
    const cfg = QUOTA_CATALOG[key];
    const override = (server.quota || {})[key] || {};
    const account = override.account || server.account;
    const lastRun = quotaLastRunFor(server);
    const nowSecs = Math.floor(Date.now() / 1000);
    const buckets = cfg.buckets.map((b) => {
      const used = (override.used && b.bucket in override.used) ? override.used[b.bucket] : b.used;
      return {
        account,
        bucket: b.bucket,
        bucket_label: b.label,
        used_percent: used,
        remaining_percent: Math.round((100 - used) * 100) / 100,
        resets_at: nowSecs + b.resetSeconds,
        captured_at: lastRun,
        source: cfg.source,
        status: "ok",
      };
    });

    const provider = {
      provider: key,
      network_enabled: !!quotaConsent[cfg.source],
      plan: "plan" in override ? override.plan : cfg.plan,
      buckets,
      status: "ok",
      status_detail: null,
      status_at: lastRun,
      updated_at: lastRun,
      sources: [cfg.source],
    };
    // Codex reset credits are a Codex-only surface.
    if (cfg.resetCredits) {
      provider.reset_credits = {
        available_count: cfg.resetCredits.available,
        credits: cfg.resetCredits.expiresInDays.map((days, idx) => ({
          id: `rc-${days}d-${server.id}`,
          title: "Reset credit",
          expires_at: nowSecs + days * 86400,
        })),
      };
    }
    return provider;
  }

  function getQuotaState(server) {
    const lastRun = quotaLastRunFor(server);
    const providers = {};
    for (const key of serverQuotaKeys(server)) providers[key] = quotaProviderPayload(server, key);
    const networkEnabled = Object.values(quotaConsent).some(Boolean);

    return {
      providers,
      consent: quotaConsent,
      enabled: quotaTrackingEnabled,
      poll: {
        enabled: quotaTrackingEnabled,
        network_enabled: networkEnabled,
        interval: quotaPollIntervalMinutes * 60,
        interval_source: "config",
        interval_minutes: quotaPollIntervalMinutes,
        interval_choices: [15, 30, 60, 120],
        last_run: lastRun,
        kill_switch: false,
      },
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  function buildQuotaHistory(server, granularity, start) {
    const nowSecs = Math.floor(Date.now() / 1000);
    const period = granularity === "day" ? 86400 : 3600;
    const limit = granularity === "day" ? 30 : 24;
    // Same sawtooth per bucket, shifted per machine so three servers do not draw
    // three identical curves.
    const offset = hash32(server.id) % 37;

    const series = [];
    for (const key of serverQuotaKeys(server)) {
      const cfg = QUOTA_CATALOG[key];
      const override = (server.quota || {})[key] || {};
      for (const b of cfg.buckets) {
        const entry = {
          provider: key,
          account: override.account || server.account,
          bucket: b.bucket,
          bucket_label: b.label,
          points: [],
          consumption: [],
        };
        const resetInterval = granularity === "day" ? 5 : 6;
        const usedAt = (step) => (step * b.drift * 12 + 10 + offset) % 100;
        for (let i = limit; i >= 0; i--) {
          const ts = nowSecs - i * period;
          const step = (limit - i) % resetInterval;
          const used = usedAt(step);
          const prev = usedAt((step - 1 + resetInterval) % resetInterval);
          entry.points.push({ captured_at: ts, used_percent: Number(used.toFixed(4)) });
          entry.consumption.push({
            period_start: ts,
            consumed_percent: Number((used > prev ? used - prev : used).toFixed(4)),
          });
        }
        series.push(entry);
      }
    }

    return { series };
  }

  function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
  function gauss(mean, sd) {
    // Box–Muller; clamps at 0
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.max(0, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  function randInt(lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }
  function randomIdPart(length) {
    let out = "";
    while (out.length < length) out += Math.floor(rand() * 36).toString(36);
    return out;
  }

  // ---------- Catalogue ----------
  // Tools that the dashboard treats as "coding tools".
  // Weights sum to ~1.0 across CODING_TOOLS + OPENCLAW.
  const CODING_TOOLS = [
    { source: "codex",       label: "Codex",              weight: 0.17 },
    { source: "claude_code", label: "Claude Code",        weight: 0.16 },
    { source: "opencode",    label: "OpenCode",           weight: 0.08 },
    { source: "gemini",      label: "Gemini CLI",         weight: 0.07 },
    { source: "kimi",        label: "Kimi CLI",           weight: 0.04 },
    { source: "pi_agent",    label: "Pi",                 weight: 0.03 },
    { source: "copilot_cli", label: "GitHub Copilot CLI", weight: 0.04 },
    { source: "hermes",      label: "Hermes",             weight: 0.03 },
    { source: "mimo",        label: "Mimo",               weight: 0.02 },
    { source: "dsh",         label: "DeepSeek Harness",   weight: 0.03 },
    { source: "reasonix",    label: "Reasonix",           weight: 0.02 },
    { source: "zcode",       label: "ZCode",              weight: 0.02 },
    { source: "workbuddy",   label: "WorkBuddy",          weight: 0.02 },
    { source: "qoder",       label: "Qoder IDE",          weight: 0.02 },
    { source: "qoder_cli",   label: "Qoder CLI",          weight: 0.02 },
    { source: "omp",         label: "omp",                weight: 0.03 },
    { source: "kilocode",    label: "Kilo Code",          weight: 0.02 },
    { source: "cline",       label: "Cline",              weight: 0.03 },
    { source: "grok",            label: "Grok Build",     weight: 0.02 },
    { source: "antigravity_cli", label: "Antigravity CLI", weight: 0.02 },
    { source: "zed",             label: "Zed",            weight: 0.02 },
    { source: "qwen_code",       label: "Qwen Code",      weight: 0.02 },
    { source: "crush",           label: "Crush",          weight: 0.02 },
    { source: "muse",            label: "Muse Code",      weight: 0.02 },
  ];
  // OpenClaw is a separate app (its own panel in the UI).
  const OPENCLAW = { source: "openclaw", label: "OpenClaw", weight: 0.05 };

  // (model name, provider, $/M input, $/M output, $/M cache_read, $/M cache_write, weight by tool)
  const MODELS = [
    { name: "openai/gpt-5.2-codex",       provider: "openai",     in: 1.75, out: 14.00, cr: 0.175, cw: 1.75, tools: { codex: 0.55, opencode: 0.20, gemini: 0.05, copilot_cli: 0.30, workbuddy: 0.30, qoder: 0.55, qoder_cli: 0.45, kilocode: 0.35, cline: 0.30, zed: 0.25 } },
    { name: "openai/gpt-5.1-codex-max",   provider: "openai",     in: 1.25, out: 10.00, cr: 0.125, cw: 1.25, tools: { codex: 0.20 } },
    { name: "openai/gpt-5.1-codex-mini",  provider: "openai",     in: 0.25, out: 2.00,  cr: 0.025, cw: 0.25, tools: { codex: 0.15, gemini: 0.10, opencode: 0.10, qoder: 0.25, qoder_cli: 0.35 } },
    { name: "openai/gpt-5.5",             provider: "openai",     in: 5.00, out: 30.00, cr: 0.50, cw: 5.00,  tools: { copilot_cli: 0.50, hermes: 0.15 } },
    { name: "anthropic/claude-opus-4.7",  provider: "anthropic",  in: 15.0, out: 75.00, cr: 1.50, cw: 15.0, tools: { claude_code: 0.45, opencode: 0.10, openclaw: 0.45, hermes: 0.25 } },
    { name: "anthropic/claude-sonnet-4.6",provider: "anthropic",  in: 3.00, out: 15.00, cr: 0.30, cw: 3.00, tools: { claude_code: 0.40, opencode: 0.30, openclaw: 0.35, copilot_cli: 0.20, hermes: 0.30, reasonix: 0.45, workbuddy: 0.35, kilocode: 0.35, cline: 0.40, zed: 0.25, crush: 0.30 } },
    { name: "anthropic/claude-haiku-4.5", provider: "anthropic",  in: 0.80, out: 4.00,  cr: 0.08, cw: 0.80, tools: { claude_code: 0.10, openclaw: 0.05, cline: 0.15 } },
    { name: "google/gemini-3-pro-preview",provider: "google",     in: 2.00, out: 12.00, cr: 0.20, cw: 0.375, tools: { gemini: 0.55, openclaw: 0.05, cline: 0.15, antigravity_cli: 0.35 } },
    { name: "google/gemini-3-flash-preview",provider: "google",   in: 0.50, out: 3.00,  cr: 0.05, cw: 0.083333, tools: { gemini: 0.30, antigravity_cli: 0.25, zed: 0.20 } },
    { name: "moonshotai/kimi-k2.6",       provider: "moonshotai", in: 0.60, out: 2.50,  cr: 0.15, cw: 0.60, tools: { kimi: 0.85, openclaw: 0.05 } },
    { name: "minimax/minimax-m2.7",       provider: "minimax",    in: 0.30, out: 1.20,  cr: 0.06, cw: 0.30,  tools: { pi_agent: 0.80, hermes: 0.30, mimo: 0.90, workbuddy: 0.20, omp: 0.55 } },
    { name: "openai/gpt-5.2",             provider: "openai",     in: 1.75, out: 14.00, cr: 0.175, cw: 1.75, tools: { pi_agent: 0.20, omp: 0.30 } },
    { name: "z-ai/glm-5.1",               provider: "z-ai",       in: 0.30, out: 1.10,  cr: 0.06, cw: 0.30, tools: { kimi: 0.15, opencode: 0.30, openclaw: 0.05, reasonix: 0.55, zcode: 1.00, workbuddy: 0.15, qoder: 0.20, qoder_cli: 0.20, omp: 0.15, kilocode: 0.15, crush: 0.30 } },
    { name: "deepseek/deepseek-v3.2",     provider: "deepseek",   in: 0.28, out: 0.42,  cr: 0.13, cw: 0.28, tools: { dsh: 0.85, opencode: 0.05, kilocode: 0.15, crush: 0.20 } },
    { name: "deepseek/deepseek-r1",       provider: "deepseek",   in: 0.70, out: 2.50,  cr: 0.028, cw: 0.28, tools: { dsh: 0.15 } },
    { name: "xai/grok-4",                 provider: "xai",        in: 3.00, out: 15.00, cr: 0.75, cw: 3.00, tools: { grok: 0.90 } },
    { name: "qwen/qwen3-coder",           provider: "qwen",       in: 0.30, out: 1.20,  cr: 0.06, cw: 0.30, tools: { qwen_code: 0.90 } },
    { name: "meta/muse-spark-1.3",        provider: "meta",       in: 1.25, out: 4.25,  cr: 0.15, cw: 1.25, tools: { muse: 0.75 } },
    { name: "meta/muse-glimmer-30b",      provider: "meta",       in: 0.35, out: 1.50,  cr: 0.04, cw: 0.35, tools: { muse: 0.25 } },
  ];

  function pickModelFor(toolSource) {
    const candidates = MODELS.filter((m) => m.tools[toolSource]);
    let total = 0;
    for (const m of candidates) total += m.tools[toolSource];
    let r = rand() * total;
    for (const m of candidates) {
      r -= m.tools[toolSource];
      if (r <= 0) return m;
    }
    return candidates[0];
  }

  const PROJECTS = [
    "web-app", "api-service", "cli-tool", "mobile-app", "data-pipeline",
    "docs-site", "auth-service", "worker-node", "analytics-dashboard", "testing-harness"
  ];

  // Human-readable per-session titles (replace the old "<project>-<hex>" label). The
  // Sessions tab already groups rows under the project name, so the row label is just a
  // short task description (action + area). Assigned once per session at creation so it
  // stays stable across requests; action + area give ~350 combinations for variety.
  const SESSION_ACTIONS = [
    "Fix", "Refactor", "Add", "Debug", "Optimize", "Implement", "Update", "Investigate",
    "Improve", "Migrate", "Harden", "Rework", "Document", "Test", "Simplify",
  ];
  const SESSION_AREAS = [
    "login flow", "auth middleware", "pagination", "the retry logic", "cache invalidation",
    "error handling", "the config loader", "rate limiting", "the CI pipeline", "database migrations",
    "the search index", "session handling", "input validation", "the API client", "structured logging",
    "the build script", "webhook delivery", "the settings page", "type definitions", "flaky tests",
    "the onboarding flow", "the health check", "background jobs", "the export job", "pagination cursors",
  ];

  // ---------- Demo server fleet ----------
  // Multi-server is a headline feature, so the demo ships a fleet of three Tokdash
  // servers: the origin serving this page ("Local") plus two synthetic remotes.
  // Their URLs never leave the browser — window.fetch is patched, so a request for
  // https://wsl-desktop.ts.net/api/usage is answered from this file with that
  // machine's slice of the synthetic history.
  //
  // weight    relative share of each tool the machine runs (normalized per tool)
  // exclude   tool sources this machine does not run, so its cards differ by mix
  // projects  project pool the machine renames its sessions into (null = keep)
  const SERVER_FLEET = [
    {
      id: "local",
      label: "Local",
      baseUrl: "",                       // same origin as the demo page
      account: "demo@tokdash.io",
      weight: 1.0,
      exclude: [],
      projects: null,
      stalenessSeconds: 0,               // its last refresh is "now"
      quotaLastRunMinutesAgo: 8,
      quota: { codex: {}, claude: {}, antigravity: {}, minimax: {}, kimi: {}, grok: {}, zai: {}, opencode_go: {} },
    },
    {
      id: "wsl",
      label: "WSL workstation",
      baseUrl: "https://wsl-desktop.ts.net",
      account: "builds@wsl-desktop",
      weight: 0.45,
      exclude: ["openclaw", "copilot_cli", "zcode", "qoder", "qoder_cli", "kilocode", "workbuddy"],
      projects: ["ingest-runner", "postgres-ops", "rust-gateway", "k8s-runners", "dotfiles-wsl",
                 "build-cache", "terraform-vpc", "nightly-bench", "kernel-module", "backup-daemon"],
      stalenessSeconds: 42,
      quotaLastRunMinutesAgo: 3,
      quota: {
        codex: { used: { "5h": 71.5, "7d": 88.2, spark_5h: 60.0, spark_7d: 74.5 } },
        kimi: { plan: "Moderato", used: { coding: 12.5 } },
        minimax: { used: { standard: 63.0 } },
        opencode_go: { used: { rolling: 82.5, weekly: 91.0, monthly: 57.5 } },
      },
    },
    {
      id: "studio",
      label: "Mac Studio",
      baseUrl: "https://mac-studio.ts.net",
      account: "me@studio-mac",
      weight: 0.2,
      exclude: ["openclaw", "dsh", "mimo", "qwen_code", "crush", "gemini", "antigravity_cli",
                "qoder", "qoder_cli", "hermes"],
      projects: ["photo-pipeline", "swift-render", "audio-plugin", "shorts-renderer", "logic-scripts",
                 "home-automation", "family-photo-app", "midi-tools", "studio-dash", "film-scratch"],
      stalenessSeconds: 191,
      quotaLastRunMinutesAgo: 34,
      quota: {
        claude: { plan: "Max", used: { session: 22.4, weekly_all: 63.9 } },
        grok: { used: { build: 47.0 } },
      },
    },
  ];
  const LOCAL_FLEET_ID = "local";
  const FLEET_BY_HOST = new Map(
    SERVER_FLEET.filter((s) => s.baseUrl).map((s) => [new URL(s.baseUrl).host, s])
  );

  // Deterministic FNV-1a over the session id: a session lands on the same machine
  // across reloads, so drill-downs and per-server counts never disagree.
  function hash32(value) {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ---------- Time helpers ----------
  const MS_DAY = 24 * 60 * 60 * 1000;
  function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  }
  function ymd(d) {
    const c = new Date(d);
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-${String(c.getDate()).padStart(2, "0")}`;
  }
  function isoOf(ms) { return new Date(ms).toISOString(); }

  // Anchor the synthetic timeline at "today" (so the demo always shows fresh data).
  const NOW = startOfDay(new Date()).getTime() + 18 * 3600 * 1000; // ~6pm "now"
  const HISTORY_DAYS = 120;

  // ---------- Synthetic dataset ----------
  // One pass: build per-tool sessions, each with a list of timestamped turns.
  // Aggregations for /api/usage and /api/stats are computed from these turns,
  // mirroring how the real backend aggregates session logs.
  const allSessions = []; // [{ tool, source, session_id, project, turns: [{ ts_ms, model, tokens_in, tokens_out, tokens_cache, tokens_reasoning, tokens, cost }] }]
  // The slice the builders below aggregate. Swapped per request by useServer() when
  // the request was addressed to one of the demo's remote fleet URLs.
  let sessions = allSessions;

  function makeSession(toolSpec, dayMs) {
    const startMs = dayMs + randInt(8, 22) * 3600 * 1000 + randInt(0, 59) * 60 * 1000;
    // Turns == messages == token_events. The demo targets a heavy power-user profile
    // (~100x the original volume), so the scale-up lives here in the turn count (each
    // turn keeps a realistic, noisy per-message token size) rather than in the per-turn
    // token amounts — that keeps total tokens AND total messages both ~100x with a
    // sane tokens-per-message ratio. Session count is also raised (see buildHistory).
    const turnCount = Math.max(1, Math.round(gauss(170, 105)));
    const session_id = randomIdPart(16);
    const project = pick(PROJECTS);
    const task = `${pick(SESSION_ACTIONS)} ${pick(SESSION_AREAS)}`;
    const turns = [];
    let cursorMs = startMs;
    const sessionModel = pickModelFor(toolSpec.source); // mostly one model per session
    for (let i = 0; i < turnCount; i++) {
      cursorMs += randInt(10, 240) * 1000;
      // 85% chance to keep the session model, otherwise drift to another candidate.
      const m = rand() < 0.85 ? sessionModel : pickModelFor(toolSpec.source);
      const tokens_in   = Math.round(gauss(1200, 700));
      const tokens_out  = Math.round(gauss(900, 600));
      const tokens_cache = Math.round(gauss(2400, 2000));
      const tokens_reasoning = m.name.includes("codex") || m.name.includes("opus") ? Math.round(gauss(400, 300)) : 0;
      const cost =
        (tokens_in * m.in + tokens_out * m.out + tokens_cache * m.cr) / 1_000_000;
      const tokens = tokens_in + tokens_out + tokens_cache + tokens_reasoning;
      turns.push({
        timestamp_ms: cursorMs,
        turn_index: i + 1,
        model: m.name,
        tokens_in, tokens_out, tokens_cache, tokens_reasoning,
        tokens, cost,
      });
    }
    // ~15% of Codex sessions simulate review/auto-permission runs, hidden by default.
    const is_review_session = toolSpec.source === "codex" && rand() < 0.15;
    return {
      tool: toolSpec.source === "claude_code" ? "claude" : toolSpec.source, // /api/sessions uses 'claude' as the tool key
      source: toolSpec.source,
      session_id,
      project,
      task,
      turns,
      is_review_session,
    };
  }

  (function buildHistory() {
    const allTools = [...CODING_TOOLS, OPENCLAW];
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const dayMs = startOfDay(NOW - d * MS_DAY).getTime();
      // Activity envelope: weekday > weekend, recent days a touch heavier.
      const dow = new Date(dayMs).getDay();
      const weekend = dow === 0 || dow === 6 ? 0.55 : 1.0;
      const recency = 0.7 + 0.6 * (1 - d / HISTORY_DAYS);
      // Skip ~12% of days entirely (vacation / quiet days) — but never skip
      // "today" so the default Today view always shows every agent.
      if (d > 0 && rand() < 0.12 * (dow === 0 ? 1.6 : 1)) continue;
      for (const tool of allTools) {
        const expected = tool.weight * 54.0 * weekend * recency; // sessions per tool per day (heavy-user demo profile)
        // Floor at 1 so every agent renders on every active day — the demo's
        // purpose is to showcase all supported tools, not to vary which ones
        // are visible from day to day.
        const count = Math.max(1, Math.round(gauss(expected, expected * 0.6)));
        for (let i = 0; i < count; i++) allSessions.push(makeSession(tool, dayMs));
      }
    }
  })();

  // ---------- Fleet partition ----------
  // One pass over the generated sessions: each lands on exactly one machine, drawn
  // from that tool's owner weights. Owners are disjoint, so the project rename below
  // is safe to do in place.
  const sessionsByServer = new Map();

  (function partitionFleet() {
    const cdf = new Map(); // source -> [{ server, limit }] with limits ending at 1
    for (const tool of [...CODING_TOOLS, OPENCLAW]) {
      const owners = SERVER_FLEET.filter((s) => !s.exclude.includes(tool.source));
      const total = owners.reduce((sum, s) => sum + s.weight, 0) || 1;
      let acc = 0;
      cdf.set(tool.source, owners.map((s) => ({
        server: s,
        limit: (acc += s.weight / total),
      })));
    }
    for (const s of SERVER_FLEET) sessionsByServer.set(s.id, []);
    for (const s of allSessions) {
      const rows = cdf.get(s.source);
      let owner = rows ? rows[rows.length - 1].server : SERVER_FLEET[0];
      if (rows) {
        const roll = (hash32(s.session_id) % 10000) / 10000;
        for (const row of rows) if (roll < row.limit) { owner = row.server; break; }
      }
      if (owner.projects) {
        s.project = owner.projects[hash32(s.session_id + "#p") % owner.projects.length];
      }
      sessionsByServer.get(owner.id).push(s);
    }
  })();

  function useServer(server) {
    sessions = sessionsByServer.get(server.id) || allSessions;
  }

  // ---------- Query helpers ----------
  function periodToRange(period, dateFrom, dateTo) {
    if (dateFrom && dateTo) {
      const since = new Date(dateFrom + "T00:00:00").getTime();
      const until = new Date(dateTo + "T00:00:00").getTime() + MS_DAY;
      return { since, until };
    }
    const todayStart = startOfDay(NOW).getTime();
    if (period === "month") {
      const d = new Date(NOW);
      const since = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      return { since, until: todayStart + MS_DAY };
    }
    let days = 1;
    const map = { today: 1, "3days": 3, week: 7, "14days": 14, month: 30 };
    if (period in map) days = map[period];
    else if (!isNaN(parseInt(period, 10))) days = Math.max(1, parseInt(period, 10));
    const since = todayStart - (days - 1) * MS_DAY;
    return { since, until: todayStart + MS_DAY };
  }

  // Every period-taking response names the window it actually read, so a caller can tell
  // a widened window from the token it asked for. `recognized` is false for a period this
  // shim does not know, which is the whole point of the block.
  function rangeBlock(period, range) {
    const days = Math.max(1, Math.round((range.until - range.since) / MS_DAY));
    const known = { today: 1, "3days": 3, week: 7, "14days": 14, month: 30, year: 365 };
    const recognized = period === null || period === "" || period in known
      || (!isNaN(parseInt(period, 10)) && parseInt(period, 10) > 0);
    return {
      period_requested: period || null,
      period_resolved: period || null,
      days,
      recognized,
      from: ymd(range.since),
      to: ymd(range.until - MS_DAY),
    };
  }
  function previousRange(curRange) {
    const span = curRange.until - curRange.since;
    return { since: curRange.since - span, until: curRange.since };
  }

  function* iterTurnsInRange(range, sourceFilter) {
    for (const s of sessions) {
      if (sourceFilter && !sourceFilter(s.source)) continue;
      for (const t of s.turns) {
        if (t.timestamp_ms < range.since || t.timestamp_ms >= range.until) continue;
        yield { session: s, turn: t };
      }
    }
  }

  // Cache hit rate = cache reads / (prompt input + cache reads). Mirrors the
  // frontend's hitRateFrom() and the backend's compute.cache_hit_rate. Returns
  // null when there is no prompt input, so the UI shows "n/a" rather than 0%.
  function hitRate(tokensIn, tokensCache) {
    const cache = Number(tokensCache || 0);
    const den = Number(tokensIn || 0) + cache;
    return den > 0 ? cache / den : null;
  }

  // Upstream ranks every model array by tokens, with cost and then the name's
  // code units breaking ties, and ships the money podium as its own field. The
  // demo mirrors both so the two Overview podiums cannot disagree.
  function ordinal(a, b) {
    const left = String(a), right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function modelRank(a, b) {
    return (b.tokens - a.tokens) || (b.cost - a.cost) || ordinal(a.name, b.name);
  }
  function costRank(a, b) {
    return (b.cost - a.cost) || (b.tokens - a.tokens) || ordinal(a.name, b.name);
  }

  // ---------- /api/usage ----------
  function buildUsage(period, dateFrom, dateTo) {
    const range = periodToRange(period, dateFrom, dateTo);

    const range_block = rangeBlock(period, range);
    const byApp = {};         // tool key -> aggregate (incl. models map)
    const combinedModels = {}; // model name -> aggregate
    let total_tokens = 0, total_cost = 0, total_messages = 0, total_in = 0, total_cache = 0;

    for (const { session, turn } of iterTurnsInRange(range)) {
      const src = toolKey(session.source);
      const app = (byApp[src] ||= {
        tokens: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, messages: 0, _models: {},
      });
      app.tokens += turn.tokens;
      app.tokens_in += turn.tokens_in;
      app.tokens_out += turn.tokens_out;
      app.tokens_cache += turn.tokens_cache;
      app.cost += turn.cost;
      app.messages += 1;

      const m = (app._models[turn.model] ||= {
        name: turn.model, tokens: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, messages: 0,
      });
      m.tokens += turn.tokens; m.tokens_in += turn.tokens_in; m.tokens_out += turn.tokens_out;
      m.tokens_cache += turn.tokens_cache; m.cost += turn.cost; m.messages += 1;

      const c = (combinedModels[turn.model] ||= {
        name: turn.model, tokens: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, messages: 0,
      });
      c.tokens += turn.tokens; c.tokens_in += turn.tokens_in; c.tokens_out += turn.tokens_out;
      c.tokens_cache += turn.tokens_cache; c.cost += turn.cost; c.messages += 1;

      total_tokens += turn.tokens;
      total_cost += turn.cost;
      total_messages += 1;
      total_in += turn.tokens_in;
      total_cache += turn.tokens_cache;
    }

    // Finalize apps -> { models: [...] }
    const apps = {};
    for (const [src, agg] of Object.entries(byApp)) {
      const models = Object.values(agg._models)
        .map((m) => ({ ...m, cache_hit_rate: hitRate(m.tokens_in, m.tokens_cache) }))
        .sort(modelRank);
      delete agg._models;
      apps[src] = { ...agg, cache_hit_rate: hitRate(agg.tokens_in, agg.tokens_cache), models };
    }

    const codingApps = {};
    for (const [src, v] of Object.entries(apps)) if (src !== "openclaw") codingApps[src] = v;

    const codingModels = [];
    for (const [src, v] of Object.entries(codingApps)) {
      for (const m of v.models) codingModels.push({ source: src, ...m });
    }
    codingModels.sort(modelRank);

    const openclawApp = apps.openclaw || { tokens: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, messages: 0, models: [] };
    const openclawModels = openclawApp.models.map((m) => ({ ...m })).sort(modelRank);

    const by_tool = {};
    for (const [src, v] of Object.entries(apps)) {
      // Mirrors get_usage_data() in src/tokdash/compute.py: every row carries the
      // input/cache split, OpenClaw's too; the output column lives only on the
      // per-app rows, which is why the Report tab prints an em dash for OpenClaw.
      by_tool[src] = {
        tokens: v.tokens, cost: v.cost,
        tokens_in: v.tokens_in, tokens_cache: v.tokens_cache,
        cache_hit_rate: v.cache_hit_rate,
      };
    }

    const combined = Object.values(combinedModels)
      .map((c) => ({ ...c, cache_hit_rate: hitRate(c.tokens_in, c.tokens_cache) }))
      .sort(modelRank);

    // Comparison: previous window aggregates.
    const prev = previousRange(range);
    let p_tokens = 0, p_cost = 0, p_messages = 0;
    for (const { turn } of iterTurnsInRange(prev)) {
      p_tokens += turn.tokens; p_cost += turn.cost; p_messages += 1;
    }
    const pct = (cur, prv) => (prv === 0 ? null : Math.round(((cur - prv) / prv) * 1000) / 10);

    return {
      period: period || "today",
      range: range_block,
      total_tokens,
      total_cost: Math.round(total_cost * 100) / 100,
      total_messages,
      cache_hit_rate: hitRate(total_in, total_cache),
      by_tool,
      apps: codingApps,
      coding_apps: codingApps,
      coding_models: codingModels,
      top_models: combined.slice(0, 5),
      top_models_by_cost: [...combined].sort(costRank).slice(0, 5),
      openclaw_models: openclawModels,
      combined_models: combined,
      timestamp: new Date().toISOString(),
      comparison: {
        tokens_prev: p_tokens,
        cost_prev: Math.round(p_cost * 100) / 100,
        messages_prev: p_messages,
        tokens_pct: pct(total_tokens, p_tokens),
        cost_pct: pct(total_cost, p_cost),
        messages_pct: pct(total_messages, p_messages),
      },
    };
  }

  // ---------- /api/sessions and /api/session ----------
  // Mirrors the backend's SESSION_TOOLS (src/tokdash/sessions.py). Clients with a
  // parser but no session harness (crush, zed, muse, amp) stay out of this map and
  // out of /api/active-time's by_tool, exactly as the real server leaves them.
  const SESSION_TOOL_KEYS = {
    codex: "codex",
    claude: "claude_code",
    opencode: "opencode",
    pi_agent: "pi_agent",
    mimo: "mimo",
    kimi: "kimi",
    dsh: "dsh",
    reasonix: "reasonix",
    zcode: "zcode",
    kilocode: "kilocode",
    omp: "omp",
    grok: "grok",
    hermes: "hermes",
    antigravity_cli: "antigravity_cli",
    cline: "cline",
    workbuddy: "workbuddy",
    qoder: "qoder",
    qwen_code: "qwen_code",
    openclaw: "openclaw",
    qoder_cli: "qoder_cli",
  };
  const TOOL_LABELS = {
    codex: "Codex",
    claude: "Claude Code",
    opencode: "OpenCode",
    pi_agent: "Pi",
    mimo: "Mimo",
    kimi: "Kimi",
    dsh: "DeepSeek Harness",
    reasonix: "Reasonix",
    zcode: "ZCode",
    kilocode: "Kilo Code",
    omp: "omp",
    grok: "Grok Build",
    hermes: "Hermes",
    antigravity_cli: "Antigravity CLI",
    cline: "Cline",
    workbuddy: "WorkBuddy",
    qoder: "Qoder IDE",
    qwen_code: "Qwen Code",
    openclaw: "OpenClaw",
    qoder_cli: "Qoder CLI",
  };

  // ---------- Active-time model (v1.7.0) ----------
  // Active time counts each gap between a session's token events up to an idle
  // cap (TOKDASH_ACTIVE_GAP_CAP_SECONDS, default 300s). The demo's turn gaps are
  // all 10-240s, below the cap, so active time tracks the session span. The demo
  // runs one stream per session, so clock time (merged intervals) and agent time
  // (intervals added up) are equal; the payload keeps both fields anyway so the
  // UI renders the same shapes the real backend sends.
  // One tool-key space across /api/usage, /api/insights and /api/active-time, because
  // the server has one. The Report tab joins all three on this key, so an alias here
  // would render as an em dash in its agent table rather than a merged row.
  const TOOL_KEY_BY_SOURCE = { claude_code: "claude", gemini: "gemini_cli" };
  function toolKey(source) { return TOOL_KEY_BY_SOURCE[source] || source; }
  const ACTIVE_GAP_CAP_MS = 300 * 1000;

  function turnIntervals(turns) {
    // turns: sorted by timestamp_ms
    const intervals = [];
    for (let i = 1; i < turns.length; i++) {
      const start = turns[i - 1].timestamp_ms;
      const end = start + Math.min(turns[i].timestamp_ms - start, ACTIVE_GAP_CAP_MS);
      if (end > start) intervals.push([start, end]);
    }
    return intervals;
  }

  function mergedIntervalMs(intervals) {
    if (!intervals.length) return 0;
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curStart = sorted[0][0];
    let curEnd = sorted[0][1];
    for (let i = 1; i < sorted.length; i++) {
      const [start, end] = sorted[i];
      if (start <= curEnd) {
        if (end > curEnd) curEnd = end;
      } else {
        total += curEnd - curStart;
        curStart = start;
        curEnd = end;
      }
    }
    return total + (curEnd - curStart);
  }

  function activePctChange(cur, prv) {
    // Matches the backend's pct_change: no previous figure means no percentage,
    // not an infinite jump from zero.
    if (!prv) return null;
    return Math.round(((cur - prv) / prv) * 1000) / 10;
  }

  function summarizeSession(session, range) {
    const turns = session.turns.filter((t) =>
      (!range || (t.timestamp_ms >= range.since && t.timestamp_ms < range.until))
    );
    if (turns.length === 0) return null;
    turns.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const sum = (k) => turns.reduce((a, t) => a + (t[k] || 0), 0);
    const tokens_in = sum("tokens_in");
    const tokens_out = sum("tokens_out");
    const tokens_cache = sum("tokens_cache");
    const tokens_reasoning = sum("tokens_reasoning");
    const tokens = sum("tokens");
    const cost = sum("cost");

    const perModel = {};
    for (const t of turns) perModel[t.model] = (perModel[t.model] || 0) + (t.tokens || 0);
    const top_model = Object.entries(perModel).sort((a, b) => b[1] - a[1])[0][0];

    const intervals = turnIntervals(turns);
    const span_ms = turns[turns.length - 1].timestamp_ms - turns[0].timestamp_ms;

    return {
      tool: session.tool,
      session_id: session.session_id,
      project: session.project,
      display_name: session.task || session.project,
      model: top_model,
      token_events: turns.length,
      tokens_in, tokens_cache, tokens_out, tokens_reasoning,
      tokens,
      cache_ratio: tokens > 0 ? tokens_cache / tokens : 0,
      cache_hit_rate: hitRate(tokens_in, tokens_cache),
      cost,
      started_at: isoOf(turns[0].timestamp_ms),
      last_seen_at: isoOf(turns[turns.length - 1].timestamp_ms),
      // span_ms is first-to-last event wall-clock (idle included); active_ms
      // subtracts the idle. Both are clipped to the requested window.
      span_ms: Math.max(0, span_ms),
      active_ms: mergedIntervalMs(intervals),
      active_ms_sum: intervals.reduce((a, [s, e]) => a + (e - s), 0),
      _active_intervals: intervals,
      is_review_session: !!session.is_review_session,
    };
  }

  function buildSessions(tool, period, dateFrom, dateTo, includeReviewSessions) {
    const key = String(tool || "").toLowerCase();
    const internalSource = SESSION_TOOL_KEYS[key];
    if (!internalSource) return { __error: 400, message: `Unsupported session tool: ${tool}` };

    const range = periodToRange(period, dateFrom, dateTo);
    // Codex review/auto-permission sessions are hidden unless explicitly requested,
    // matching the real backend's TOKDASH_INCLUDE_CODEX_GUARDIAN default-off behavior.
    const includeReview = key === "codex" && includeReviewSessions === "true";
    const matching = sessions.filter((s) =>
      s.source === internalSource && (includeReview || !s.is_review_session)
    );

    const summaries = [];
    const activeIntervals = [];
    for (const s of matching) {
      const summary = summarizeSession(s, range);
      if (summary) {
        activeIntervals.push(...summary._active_intervals);
        delete summary._active_intervals;
        summaries.push(summary);
      }
    }
    summaries.sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));

    return {
      tool: key,
      tool_label: TOOL_LABELS[key],
      period: period || "today",
      latest_session: summaries[0] || null,
      sessions: summaries,
      summary: {
        session_count: summaries.length,
        tokens: summaries.reduce((a, s) => a + s.tokens, 0),
        cost: summaries.reduce((a, s) => a + s.cost, 0),
        // active_ms is deduplicated wall-clock: sessions running in parallel
        // overlap and are counted once. active_ms_sum adds them up instead,
        // i.e. agent-hours rather than clock time.
        active_ms: mergedIntervalMs(activeIntervals),
        active_ms_sum: summaries.reduce((a, s) => a + s.active_ms_sum, 0),
        span_ms: summaries.reduce((a, s) => a + s.span_ms, 0),
        active_gap_cap_ms: ACTIVE_GAP_CAP_MS,
        // Inter-event gaps cannot separate a short pause from work, long single
        // operations are truncated at the cap, and a lone event measures nothing.
        active_time_estimated: true,
        active_time_method: "capped-inter-event-gap",
      },
      ...(key === "codex" ? { include_review_sessions: includeReview } : {}),
      timestamp: new Date().toISOString(),
    };
  }

  function buildSessionDetail(tool, sessionId) {
    const key = String(tool || "").toLowerCase();
    const internalSource = SESSION_TOOL_KEYS[key];
    if (!internalSource) return { __error: 400, message: `Unsupported session tool: ${tool}` };

    let found = sessions.find((s) => s.source === internalSource && s.session_id === sessionId);
    if (!found) {
      found = allSessions.find((s) => s.source === internalSource && s.session_id === sessionId);
    }
    if (!found) return { __error: 404, message: `Session not found: ${sessionId}` };

    const session = summarizeSession(found, null);
    delete session._active_intervals;
    const turns = found.turns
      .slice()
      .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
      .map((t) => ({
        turn_index: t.turn_index,
        timestamp: isoOf(t.timestamp_ms),
        model: t.model,
        tokens: t.tokens,
        tokens_in: t.tokens_in,
        tokens_cache: t.tokens_cache,
        tokens_out: t.tokens_out,
        tokens_reasoning: t.tokens_reasoning,
        cost: t.cost,
      }));
    return { session, turns, timestamp: new Date().toISOString() };
  }

  // ---------- /api/active-time (v1.7.0) ----------
  // Cross-tool runtime for the Overview's agent-time KPI: active_ms is clock time
  // across all tools (the union of every interval), active_ms_sum is the additive
  // agent time. Mirrors get_active_time_data() in src/tokdash/sessions.py.
  function activeTimeWindow(range, includeReview) {
    const by_tool = {};
    const allIntervals = [];
    for (const [key, internalSource] of Object.entries(SESSION_TOOL_KEYS)) {
      const intervals = [];
      let agent_ms = 0;
      let session_count = 0;
      for (const s of sessions) {
        if (s.source !== internalSource) continue;
        if (key === "codex" && s.is_review_session && !includeReview) continue;
        const summary = summarizeSession(s, range);
        if (!summary) continue;
        session_count += 1;
        intervals.push(...summary._active_intervals);
        agent_ms += summary.active_ms_sum;
      }
      if (!session_count) continue;
      allIntervals.push(...intervals);
      by_tool[key] = {
        tool_label: TOOL_LABELS[key],
        session_count,
        active_ms: mergedIntervalMs(intervals),
        active_ms_sum: agent_ms,
      };
    }
    return {
      by_tool,
      active_ms: mergedIntervalMs(allIntervals),
      active_ms_sum: Object.values(by_tool).reduce((a, row) => a + row.active_ms_sum, 0),
    };
  }

  function buildActiveTime(period, dateFrom, dateTo, includeReviewSessions) {
    const range = periodToRange(period, dateFrom, dateTo);
    const includeReview = includeReviewSessions === "true";
    const cur = activeTimeWindow(range, includeReview);
    const prev = activeTimeWindow(previousRange(range), includeReview);
    return {
      period: period || "today",
      active_ms: cur.active_ms,
      active_ms_sum: cur.active_ms_sum,
      comparison: {
        active_ms_prev: prev.active_ms,
        active_ms_sum_prev: prev.active_ms_sum,
        active_ms_pct: activePctChange(cur.active_ms, prev.active_ms),
        active_ms_sum_pct: activePctChange(cur.active_ms_sum, prev.active_ms_sum),
      },
      by_tool: cur.by_tool,
      unavailable_tools: [],
      active_gap_cap_ms: ACTIVE_GAP_CAP_MS,
      active_time_estimated: true,
      active_time_method: "capped-inter-event-gap",
      include_review_sessions: includeReview,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------- /api/activity-insights ----------
  // Codex Profile Activity insights (recorded chats, reasoning effort mix, tool
  // calls). Mirrors build_activity_insights() in src/tokdash/activity_insights.py.
  // Derived from the requesting machine's slice of the synthetic codex corpus.
  function buildActivityInsights() {
    const codexSessions = sessions.filter((s) => s.source === "codex");
    const recorded = codexSessions.length;
    const turns = codexSessions.reduce((a, s) => a + s.turns.length, 0);
    const effTotals = [["high", 0.38], ["medium", 0.41], ["low", 0.16], ["minimal", 0.05]];
    const effortCounts = effTotals.map(([effort, share]) => [effort, Math.round(turns * share)]);
    const toolTotals = [
      ["shell", 0.31], ["apply_patch", 0.24], ["read_file", 0.18],
      ["grep", 0.11], ["web_search", 0.09], ["update_plan", 0.07],
    ];
    const toolCounts = toolTotals.map(([name, share]) => [name, Math.round(turns * 1.9 * share)]);
    const dist = (rows, key) => {
      const total = rows.reduce((a, [, count]) => a + count, 0) || 1;
      return rows
        .map(([value, count]) => ({ [key]: value, count, share: Math.round((count / total) * 1e6) / 1e6 }))
        .sort((a, b) => b.count - a.count);
    };
    const effortDist = dist(effortCounts, "effort");
    const toolDist = dist(toolCounts, "name");
    return {
      scope: { tool: "codex", local: true, primary_only: true },
      recorded_chats: {
        value: recorded,
        coverage: {
          primary_files: recorded,
          files_with_session_id: recorded,
          legacy_unavailable_records: Math.round(recorded * 0.08),
        },
      },
      reasoning: {
        most_used: effortDist[0] || null,
        distribution: effortDist,
        coverage: {
          identified_turns: turns,
          known_effort_turns: effortCounts.reduce((a, [, c]) => a + c, 0),
          ambiguous_turns: Math.round(turns * 0.03),
          excluded_records: Math.round(turns * 0.02),
        },
      },
      tools: {
        total_calls: toolCounts.reduce((a, [, c]) => a + c, 0),
        most_used: toolDist[0] || null,
        distribution: toolDist,
        coverage: {
          named_calls: toolCounts.reduce((a, [, c]) => a + c, 0),
          ambiguous_name_calls: Math.round(turns * 0.04),
          excluded_records: Math.round(turns * 0.01),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  // Cached per machine: the profile-activity panel asks once per server.
  const activityInsightsCache = new Map();
  function activityInsightsFor(server) {
    if (!activityInsightsCache.has(server.id)) {
      useServer(server);
      activityInsightsCache.set(server.id, buildActivityInsights());
    }
    return activityInsightsCache.get(server.id);
  }

  // ---------- /api/stats ----------
  // ---------- /api/insights ----------
  // The Report tab's facet scan, folded from the same synthetic turns every other
  // endpoint reads so the report's day map, podium and rhythm cannot disagree with
  // Overview or Stats. Facet names, Monday-zero weekdays, the 22:00-02:00 night
  // window and the rank-quartile day intensity follow src/tokdash/insights.py and
  // compute.assign_contribution_intensity.
  const INSIGHTS_FACETS = ["hourly", "weekday", "heatmap", "daily", "models", "tools",
    "projects", "streaks", "firsts"];
  const INSIGHTS_DEFAULT_FACETS = ["hourly", "weekday", "heatmap", "models", "tools",
    "streaks", "firsts"];
  const INSIGHTS_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday"];
  const INSIGHTS_NIGHT_HOURS = [0, 1, 22, 23];

  function insightsTimezoneLabel() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(new Date());
      const zone = parts.find((part) => part.type === "timeZoneName");
      if (zone && zone.value) return zone.value;
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    } catch (_error) {
      return "local";
    }
  }

  // An unknown facet is refused, not dropped: a missing facet renders as a blank
  // section labelled as data, which is the reason the server answers 400.
  function parseInsightsFacets(raw) {
    const asList = (values) => values.slice();
    if (raw === null || String(raw).trim() === "") return { facets: asList(INSIGHTS_DEFAULT_FACETS) };
    const requested = String(raw).split(",")
      .map((token) => token.trim().toLowerCase()).filter(Boolean);
    if (!requested.length) return { facets: asList(INSIGHTS_DEFAULT_FACETS) };
    const unknown = [...new Set(requested.filter((f) => !INSIGHTS_FACETS.includes(f)))].sort();
    if (unknown.length) {
      return {
        error: "unknown facet(s): " + unknown.join(", ") +
          ". Accepted: " + INSIGHTS_FACETS.join(", "),
      };
    }
    return { facets: [...new Set(requested)] };
  }

  function insightsIntensity(rows) {
    // Quartiles over the active days of the window, by rank rather than by value:
    // a few very heavy days would otherwise flatten every ordinary day into the
    // bottom bucket. Mirrors compute.assign_contribution_intensity.
    const active = rows.map((row) => row.tokens).filter((t) => t > 0).sort((a, b) => a - b);
    for (const row of rows) {
      if (row.tokens <= 0) { row.intensity = 0; continue; }
      if (!active.length) { row.intensity = 0; continue; }
      let lo = 0, hi = active.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (active[mid] <= row.tokens) lo = mid + 1; else hi = mid;
      }
      row.intensity = Math.min(4, Math.max(1, Math.ceil((lo / active.length) * 4)));
    }
  }

  function insightsStreaks(dates, windowEndDay) {
    // (current, longest) runs of consecutive active days. A day still in progress
    // has not broken anything, so a run ending today or yesterday is still current.
    if (!dates.length) return { current_streak: 0, longest_streak: 0 };
    let longest = 1, run = 1;
    for (let i = 1; i < dates.length; i += 1) {
      const gap = (new Date(dates[i] + "T00:00:00") - new Date(dates[i - 1] + "T00:00:00")) / MS_DAY;
      run = gap === 1 ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    const last = dates[dates.length - 1];
    const current = (last === windowEndDay || last === ymd(new Date(windowEndDay + "T00:00:00").getTime() - MS_DAY))
      ? run : 0;
    return { current_streak: current, longest_streak: longest };
  }

  function buildInsights(period, dateFrom, dateTo, facetsRaw, includeProjectNames) {
    const parsed = parseInsightsFacets(facetsRaw);
    if (parsed.error) return { __error: 400, message: parsed.error };
    const facets = parsed.facets;
    const range = periodToRange(period, dateFrom, dateTo);

    const zero = () => ({ tokens: 0, cost: 0, messages: 0, entries: 0 });
    const add = (row, turn) => {
      row.tokens += turn.tokens;
      row.cost += turn.cost;
      row.messages += 1;
      row.entries += 1;
    };
    const getOr = (map, key) => {
      let row = map.get(key);
      if (!row) { row = zero(); map.set(key, row); }
      return row;
    };

    const days = new Map();
    const hourly = Array.from({ length: 24 }, (_, hour) => Object.assign(zero(), { hour }));
    const weekdays = Array.from({ length: 7 }, (_, index) =>
      Object.assign(zero(), { weekday: index, name: INSIGHTS_WEEKDAY_NAMES[index] }));
    const heat = Array.from({ length: 168 }, () => zero());
    const tools = new Map();
    const models = new Map();
    const projects = new Map();
    const sources = new Set();
    const totals = zero();

    for (const { session, turn } of iterTurnsInRange(range)) {
      const stamp = new Date(turn.timestamp_ms);
      const date = ymd(turn.timestamp_ms);
      const hour = stamp.getHours();
      const weekday = (stamp.getDay() + 6) % 7; // the server counts from Monday
      const tool = toolKey(session.source);

      sources.add(tool);
      add(totals, turn);
      add(getOr(days, date), turn);
      add(hourly[hour], turn);
      add(weekdays[weekday], turn);
      add(heat[weekday * 24 + hour], turn);
      add(getOr(tools, tool), turn);
      add(getOr(models, turn.model), turn);
      add(getOr(projects, session.project || ""), turn);
    }

    const money = (value) => Math.round(value * 1e6) / 1e6;
    const dayRows = [...days.entries()]
      .map(([date, row]) => Object.assign({ tokens: row.tokens, cost: money(row.cost),
        messages: row.messages, entries: row.entries, date }, {}))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    insightsIntensity(dayRows);

    const rankRows = (map, keyName) => [...map.entries()]
      .map(([name, row]) => ({ [keyName]: name, tokens: row.tokens, cost: money(row.cost),
        messages: row.messages, entries: row.entries }))
      .sort((a, b) => (b.tokens - a.tokens) || (b.cost - a.cost)
        || String(a[keyName]).localeCompare(String(b[keyName])));

    const response = {
      schema_version: 1,
      range: rangeBlock(period, range),
      facets,
      timezone: insightsTimezoneLabel(),
      coverage: {
        // Live-parsed sources are the ones /api/usage cannot rank from stored rows.
        stored_sources: [...sources].filter((tool) => tool !== "openclaw").sort(),
        live_sources: [...sources].filter((tool) => tool === "openclaw").sort(),
        group_count: totals.entries,
      },
      totals: { tokens: totals.tokens, cost: money(totals.cost),
        messages: totals.messages, entries: totals.entries },
      timestamp: new Date().toISOString(),
    };

    if (facets.includes("hourly")) {
      const busiest = hourly.filter((row) => row.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)[0] || null;
      const night = hourly.filter((row) => INSIGHTS_NIGHT_HOURS.includes(row.hour))
        .reduce((sum, row) => sum + row.tokens, 0);
      response.hourly = {
        buckets: hourly.map((row) => Object.assign({}, row, { cost: money(row.cost) })),
        peak_hour: busiest ? busiest.hour : null,
        night_share: totals.tokens ? Math.round((night / totals.tokens) * 1e4) / 1e4 : null,
        night_hours: INSIGHTS_NIGHT_HOURS.slice(),
      };
    }

    if (facets.includes("weekday")) {
      const peak = weekdays.filter((row) => row.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)[0] || null;
      response.weekday = {
        buckets: weekdays.map((row) => Object.assign({}, row, { cost: money(row.cost) })),
        peak_weekday: peak ? peak.weekday : null,
      };
    }

    if (facets.includes("heatmap")) {
      response.heatmap = {
        cells: heat.map((row, index) => Object.assign({}, row, {
          cost: money(row.cost),
          weekday: Math.floor(index / 24),
          hour: index % 24,
        })),
      };
    }

    if (facets.includes("daily")) response.daily = dayRows;

    if (facets.includes("tools")) response.tools = { ranked: rankRows(tools, "tool") };

    if (facets.includes("models")) {
      const ranked = rankRows(models, "model");
      response.models = {
        ranked,
        most_used: ranked.length ? ranked[0].model : null,
        highest_cost: ranked.length
          ? [...ranked].sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens))[0].model
          : null,
      };
    }

    if (facets.includes("projects")) {
      // Every synthetic session belongs to a project, so nothing lands in
      // `unattributed`; the key stays because the report reconciles against it.
      let ranked = rankRows(projects, "project");
      const named = includeProjectNames !== false;
      if (!named) ranked = ranked.map((row, index) => Object.assign({}, row, { project: `project-${index + 1}` }));
      response.projects = {
        projects: ranked,
        unattributed: zero(),
        attributed_project_count: ranked.length,
        names_included: named,
      };
    }

    if (facets.includes("streaks") || facets.includes("firsts")) {
      const activeDates = dayRows.filter((row) => row.tokens > 0).map((row) => row.date);
      const streaks = insightsStreaks(activeDates, ymd(range.until - MS_DAY));
      if (facets.includes("streaks")) {
        response.streaks = {
          current_streak: streaks.current_streak,
          longest_streak: streaks.longest_streak,
          active_days: activeDates.length,
          total_days: Math.max(1, Math.round((range.until - range.since) / MS_DAY)),
        };
      }
      if (facets.includes("firsts")) {
        const busiest = dayRows.filter((row) => row.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)[0] || null;
        const hourPeak = response.hourly ? response.hourly.peak_hour
          : (() => {
              const busiestHour = hourly.filter((row) => row.tokens > 0)
                .sort((a, b) => b.tokens - a.tokens)[0];
              return busiestHour ? busiestHour.hour : null;
            })();
        response.firsts = {
          first_active_day: activeDates.length ? activeDates[0] : null,
          last_active_day: activeDates.length ? activeDates[activeDates.length - 1] : null,
          busiest_day: busiest ? busiest.date : null,
          busiest_day_tokens: busiest ? busiest.tokens : null,
          peak_hour: hourPeak,
        };
      }
    }

    return response;
  }

  function buildStats(year) {
    let range;
    if (year) {
      const since = new Date(year, 0, 1).getTime();
      const until = new Date(year + 1, 0, 1).getTime();
      range = { since, until };
    } else {
      const today = startOfDay(NOW).getTime() + MS_DAY;
      range = { since: today - 365 * MS_DAY, until: today };
    }

    const days = {};
    const modelCosts = {};
    const modelTokens = {};
    let totalSessions = 0;

    for (const { session, turn } of iterTurnsInRange(range)) {
      const date = ymd(turn.timestamp_ms);
      const day = (days[date] ||= {
        date,
        totals: { tokens: 0, cost: 0, messages: 0 },
        intensity: 0,
        tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sources: [],
      });
      day.totals.tokens += turn.tokens;
      day.totals.cost += turn.cost;
      day.totals.messages += 1;
      day.tokenBreakdown.input += turn.tokens_in;
      day.tokenBreakdown.output += turn.tokens_out;
      day.tokenBreakdown.cacheRead += turn.tokens_cache;
      day.tokenBreakdown.reasoning += turn.tokens_reasoning;
      day.sources.push({
        source: session.source,
        modelId: turn.model,
        providerId: turn.model.split("/")[0] || "unknown",
        tokens: {
          input: turn.tokens_in,
          output: turn.tokens_out,
          cacheRead: turn.tokens_cache,
          cacheWrite: 0,
          reasoning: turn.tokens_reasoning,
        },
        cost: turn.cost,
        messages: 1,
      });
      modelCosts[turn.model] = (modelCosts[turn.model] || 0) + turn.cost;
      modelTokens[turn.model] = (modelTokens[turn.model] || 0) + turn.tokens;
    }
    totalSessions = sessions.reduce(
      (a, s) =>
        a + (s.turns.some((t) => t.timestamp_ms >= range.since && t.timestamp_ms < range.until) ? 1 : 0),
      0,
    );

    const dayList = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));

    // Intensity buckets: 0-4 by token volume relative to peak.
    const peak = dayList.reduce((m, d) => Math.max(m, d.totals.tokens), 0) || 1;
    for (const d of dayList) {
      const ratio = d.totals.tokens / peak;
      d.intensity = ratio === 0 ? 0 : Math.min(4, 1 + Math.floor(ratio * 4));
    }

    // Streaks
    const allDates = dayList.map((d) => d.date);
    let current_streak = 0, longest_streak = 0, run = 0;
    let prev = null;
    for (const date of allDates) {
      if (!prev) { run = 1; }
      else {
        const gap = (new Date(date) - new Date(prev)) / MS_DAY;
        run = gap === 1 ? run + 1 : 1;
      }
      longest_streak = Math.max(longest_streak, run);
      prev = date;
    }
    if (allDates.length) {
      const last = allDates[allDates.length - 1];
      const todayStr = ymd(NOW);
      const yesterdayStr = ymd(NOW - MS_DAY);
      if (last === todayStr || last === yesterdayStr) current_streak = run;
    }

    const total_tokens = dayList.reduce((a, d) => a + d.totals.tokens, 0);
    const total_cost = dayList.reduce((a, d) => a + d.totals.cost, 0);
    const active_days = dayList.length;
    const total_days = dayList.length
      ? Math.round((new Date(dayList[dayList.length - 1].date) - new Date(dayList[0].date)) / MS_DAY) + 1
      : 0;
    // "Favorite" means most used, not most expensive (upstream ranks by tokens).
    const favorite_model =
      Object.entries(modelTokens).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";
    const highest_cost_model =
      Object.entries(modelCosts).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    return {
      meta: { source: "merged" },
      summary: { totalTokens: total_tokens, totalCost: total_cost, activeDays: active_days, totalDays: total_days },
      contributions: dayList,
      stats: {
        favorite_model,
        most_used_model: favorite_model,
        highest_cost_model,
        total_tokens,
        sessions: totalSessions,
        current_streak,
        longest_streak,
        active_days,
        total_days,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ---------- /api/pricing-db (read-only, served from a static JSON file) ----------
  let pricingCache = null;
  function demoBasePath() {
    return (window.TOKDASH_BASE_PATH || "").replace(/\/+$/, "");
  }
  function demoPath(path) {
    return `${demoBasePath()}${path}`;
  }
  function localPath(pathname) {
    const base = demoBasePath();
    return base && pathname.startsWith(`${base}/`)
      ? pathname.slice(base.length)
      : pathname;
  }
  async function loadPricingDb() {
    if (pricingCache) return pricingCache;
    // Site-root path: pricing_db.json lives beside index.html, while the demo
    // page is served from /demo/. Preserve any Pages base path such as /tokdash.
    const res = await origFetch(demoPath("/pricing_db.json"), { cache: "no-store" });
    const data = await res.json();
    const text = JSON.stringify(data, null, 2) + "\n";
    pricingCache = { path: "demo://pricing_db.json", data, text };
    return pricingCache;
  }

  // ---------- Dispatcher ----------
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function parseUrl(input) {
    let urlStr;
    if (typeof input === "string") urlStr = input;
    else if (input instanceof Request) urlStr = input.url;
    else urlStr = String(input);
    // Resolve relative to current origin (any of /api/... will start with /)
    return new URL(urlStr, window.location.origin);
  }

  // Which machine a request was addressed to. The dashboard builds remote URLs
  // from the server registry, so host matching is the whole routing table.
  function serverForUrl(url) {
    return FLEET_BY_HOST.get(url.host) || SERVER_FLEET[0];
  }

  // Each machine last refreshed at its own minute; the Servers tab shows the
  // per-card time and names the stalest server in the combined header.
  function stampForServer(payload, server) {
    if (!server.stalenessSeconds || !payload || !payload.timestamp) return payload;
    const at = Date.parse(payload.timestamp) - server.stalenessSeconds * 1000;
    if (!Number.isNaN(at)) payload.timestamp = new Date(at).toISOString();
    return payload;
  }

  async function dispatch(input, init) {
    const url = parseUrl(input);
    const server = serverForUrl(url);
    const path = localPath(url.pathname);
    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");

    // /health is the fleet fingerprint: the dashboard probes it before it will add
    // a server, and refuses any answer that does not identify itself as Tokdash.
    if (path === "/health" && method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "tokdash",
        version: "demo",
        hostname: server.id === LOCAL_FLEET_ID ? window.location.hostname : url.hostname,
        demo: true,
      });
    }
    if (!path.startsWith("/api/")) return null; // not ours

    // Point every dataset-backed builder at the machine this request addressed.
    useServer(server);
    const params = url.searchParams;

    if (path === "/api/usage" && method === "GET") {
      return jsonResponse(stampForServer(
        buildUsage(params.get("period"), params.get("date_from"), params.get("date_to")), server));
    }
    if (path === "/api/sessions" && method === "GET") {
      const out = buildSessions(
        params.get("tool"), params.get("period"), params.get("date_from"), params.get("date_to"),
        params.get("include_review_sessions")
      );
      if (out.__error) return jsonResponse({ detail: out.message }, out.__error);
      return jsonResponse(out);
    }
    if (path === "/api/session" && method === "GET") {
      const out = buildSessionDetail(params.get("tool"), params.get("session_id"));
      if (out.__error) return jsonResponse({ detail: out.message }, out.__error);
      return jsonResponse(out);
    }
    if (path === "/api/active-time" && method === "GET") {
      return jsonResponse(
        buildActiveTime(params.get("period"), params.get("date_from"), params.get("date_to"), params.get("include_review_sessions"))
      );
    }
    if (path === "/api/insights" && method === "GET") {
      const out = buildInsights(
        params.get("period"), params.get("date_from"), params.get("date_to"),
        params.get("facets"), params.get("include_project_names") !== "false"
      );
      if (out.__error) return jsonResponse({ detail: out.message }, out.__error);
      return jsonResponse(stampForServer(out, server));
    }
    if (path === "/api/activity-insights" && method === "GET") {
      return jsonResponse(activityInsightsFor(server));
    }
    if (path === "/api/version" && method === "GET") {
      // The static demo runs no update checks (opt-in server feature), so the
      // dashboard's update notice stays in its muted one-click opt-in state.
      return jsonResponse({
        service: "tokdash",
        runtime_version: "demo",
        install_method: null,
        update_check_enabled: false,
      });
    }
    if (path === "/api/stats" && method === "GET") {
      const yr = params.get("year");
      return jsonResponse(buildStats(yr ? parseInt(yr, 10) : null));
    }
    if (path === "/api/pricing-db" && method === "GET") {
      return jsonResponse(await loadPricingDb());
    }
    if (path === "/api/pricing-db" && method === "PUT") {
      return jsonResponse({ detail: "The pricing database is read-only in the static demo." }, 405);
    }
    if (path === "/api/csrf-token" && method === "GET") {
      // Same-origin write token. The static demo has no real CSRF surface, but the
      // frontend's postJsonWithCsrf() fetches this before every write (quota toggle,
      // poll interval, consent, refresh), so echo a stable placeholder token so those
      // POSTs succeed instead of throwing on a 501.
      return jsonResponse({ token: "demo" });
    }
    if (path === "/api/quota" && method === "GET") {
      return jsonResponse(getQuotaState(server));
    }
    if (path === "/api/quota/history" && method === "GET") {
      return jsonResponse(buildQuotaHistory(server, params.get("granularity") || "hour", params.get("start")));
    }
    if (path === "/api/quota/consent" && method === "POST") {
      try {
        const bodyText = (init && init.body) || "";
        const payload = bodyText ? JSON.parse(bodyText) : {};
        Object.assign(quotaConsent, payload);
      } catch (e) {}
      return jsonResponse({ consent: quotaConsent });
    }
    if (path === "/api/quota/settings" && method === "POST") {
      try {
        const bodyText = (init && init.body) || "";
        const payload = bodyText ? JSON.parse(bodyText) : {};
        if ("enabled" in payload) quotaTrackingEnabled = !!payload.enabled;
        if ("poll_interval_minutes" in payload) quotaPollIntervalMinutes = Number(payload.poll_interval_minutes);
      } catch (e) {}
      return jsonResponse({
        enabled: quotaTrackingEnabled,
        poll_interval_minutes: quotaPollIntervalMinutes,
        interval: quotaPollIntervalMinutes * 60,
        interval_source: "config"
      });
    }
    if (path === "/api/quota/refresh" && method === "GET") {
      quotaLastRunByServer.set(server.id, Math.floor(Date.now() / 1000));
      const buckets = serverQuotaKeys(server)
        .reduce((sum, key) => sum + QUOTA_CATALOG[key].buckets.length, 0);
      return jsonResponse({ snapshots: buckets, inserted: buckets });
    }
    if (path === "/api/openclaw" && method === "GET") {
      // Not consumed by the current UI but easy to support for parity.
      return jsonResponse({ total_tokens: 0, total_cost: 0, total_messages: 0, models: {} });
    }
    if (path === "/api/tools" && method === "GET") {
      return jsonResponse({ entries: [] });
    }
    return jsonResponse({ detail: `Demo: not implemented (${method} ${path})` }, 501);
  }

  // ---------- Install ----------
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const handled = await dispatch(input, init);
      if (handled) return handled;
    } catch (err) {
      console.error("[mock-api]", err);
      return new Response(JSON.stringify({ detail: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return origFetch(input, init);
  };

  // ---------- Seed the fleet into the dashboard's server registry ----------
  // Without this the Servers tab stays hidden (it appears once a second server
  // exists) and the multi-server selector in Settings has nothing to offer. Only
  // ever written once, and never over a registry the visitor built themselves.
  (function seedDemoServers(storage) {
    const MARKER = "tokdash-demo-servers-seeded";
    const VERSION = "1";
    try {
      if (storage.getItem(MARKER) === VERSION) return;
      storage.setItem(MARKER, VERSION);
      if (storage.getItem("tokdash-servers")) return; // a hand-built registry wins
      storage.setItem("tokdash-servers", JSON.stringify(
        SERVER_FLEET
          .filter((s) => s.baseUrl)
          .map((s) => ({ id: s.id, label: s.label, baseUrl: s.baseUrl }))
      ));
    } catch (_error) {
      // Private mode / storage disabled: the demo still runs as a single server.
    }
  })(window.localStorage);

  // Expose a tiny info API on the window for debugging / banner labels.
  window.__TOKDASH_DEMO__ = {
    sessionsCount: allSessions.length,
    historyDays: HISTORY_DAYS,
    seed: 0x70B05A1,
    // The lists below are what check_demo_sync.py and the smoke tests read, so they
    // compare the demo against the upstream UI instead of a hardcoded copy.
    sessionTools: Object.keys(SESSION_TOOL_KEYS),
    toolLabels: { ...TOOL_LABELS },
    quotaProviders: Object.keys(QUOTA_CATALOG),
    sources: [...CODING_TOOLS.map((t) => t.source), OPENCLAW.source],
    // The tool-key space the API answers with, so a caller can name a client the
    // way the dashboard does.
    toolKeys: [...CODING_TOOLS.map((t) => t.source), OPENCLAW.source].map(toolKey),
    // Clients with usage but no session harness: they carry tokens everywhere and
    // print an em dash in the Report tab's sessions/runtime columns, upstream too.
    toolsWithoutSessions: () =>
      [...CODING_TOOLS.map((t) => t.source), OPENCLAW.source]
        .filter((src) => !Object.values(SESSION_TOOL_KEYS).includes(src))
        .map(toolKey),
    servers: SERVER_FLEET.map((s) => ({
      id: s.id,
      label: s.label,
      baseUrl: s.baseUrl,
      sessions: sessionsByServer.get(s.id)?.length || 0,
    })),
  };
})();

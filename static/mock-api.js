/*
 * Tokdash demo — synthetic backend
 * ---------------------------------
 * The real Tokdash app reads usage data from a local FastAPI server. This file
 * patches `window.fetch` so the unmodified frontend can run as a static site
 * (GitHub Pages) against deterministic, fully synthetic data.
 *
 * Routes mocked (must match src/tokdash/api.py):
 *   GET  /api/usage     ?period=… | ?date_from=…&date_to=…
 *   GET  /api/sessions  ?tool=codex|claude|opencode (&period=… | &date_from/to)
 *   GET  /api/session   ?tool=…&session_id=…
 *   GET  /api/stats     [?year=…]
 *   GET  /api/pricing-db
 *   PUT  /api/pricing-db          (no-op — demo cannot persist)
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

  function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
  function gauss(mean, sd) {
    // Box–Muller; clamps at 0
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.max(0, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  function randInt(lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }

  // ---------- Catalogue ----------
  // Tools that the dashboard treats as "coding tools".
  const CODING_TOOLS = [
    { source: "codex",       label: "Codex",       weight: 0.34 },
    { source: "claude_code", label: "Claude Code", weight: 0.30 },
    { source: "opencode",    label: "OpenCode",    weight: 0.14 },
    { source: "gemini",      label: "Gemini CLI",  weight: 0.10 },
    { source: "kimi",        label: "Kimi CLI",    weight: 0.06 },
  ];
  // OpenClaw is a separate app (its own panel in the UI).
  const OPENCLAW = { source: "openclaw", label: "OpenClaw", weight: 0.06 };

  // (model name, provider, $/M input, $/M output, $/M cache_read, $/M cache_write, weight by tool)
  const MODELS = [
    { name: "openai/gpt-5.4-codex",       provider: "openai",     in: 1.50, out: 12.00, cr: 0.15, cw: 1.50, tools: { codex: 0.55, opencode: 0.20, gemini: 0.05 } },
    { name: "openai/gpt-5.4-codex-high",  provider: "openai",     in: 3.00, out: 24.00, cr: 0.30, cw: 3.00, tools: { codex: 0.20 } },
    { name: "openai/gpt-5.4-mini",        provider: "openai",     in: 0.40, out: 1.60,  cr: 0.04, cw: 0.40, tools: { codex: 0.15, gemini: 0.10, opencode: 0.10 } },
    { name: "anthropic/claude-opus-4.7",  provider: "anthropic",  in: 15.0, out: 75.00, cr: 1.50, cw: 15.0, tools: { claude_code: 0.45, opencode: 0.10, openclaw: 0.45 } },
    { name: "anthropic/claude-sonnet-4.6",provider: "anthropic",  in: 3.00, out: 15.00, cr: 0.30, cw: 3.00, tools: { claude_code: 0.40, opencode: 0.30, openclaw: 0.35 } },
    { name: "anthropic/claude-haiku-4.5", provider: "anthropic",  in: 0.80, out: 4.00,  cr: 0.08, cw: 0.80, tools: { claude_code: 0.10, openclaw: 0.05 } },
    { name: "google/gemini-3-pro",        provider: "google",     in: 1.25, out: 5.00,  cr: 0.13, cw: 1.25, tools: { gemini: 0.55, openclaw: 0.05 } },
    { name: "google/gemini-3-flash",      provider: "google",     in: 0.10, out: 0.40,  cr: 0.01, cw: 0.10, tools: { gemini: 0.30 } },
    { name: "moonshotai/kimi-k2.6",       provider: "moonshotai", in: 0.60, out: 2.50,  cr: 0.15, cw: 0.60, tools: { kimi: 0.85, openclaw: 0.05 } },
    { name: "z-ai/glm-5.1",               provider: "z-ai",       in: 0.30, out: 1.10,  cr: 0.06, cw: 0.30, tools: { kimi: 0.15, opencode: 0.30, openclaw: 0.05 } },
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
    "tokdash", "ravqa-v2", "personal-memory-qa", "auto-research", "vlm-evalkit",
    "agent-digest", "coding-agent", "language-learning-ai", "video-gen", "p-test",
  ];

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
  const sessions = []; // [{ tool, source, session_id, project, turns: [{ ts_ms, model, tokens_in, tokens_out, tokens_cache, tokens_reasoning, tokens, cost }] }]

  function makeSession(toolSpec, dayMs) {
    const startMs = dayMs + randInt(8, 22) * 3600 * 1000 + randInt(0, 59) * 60 * 1000;
    const turnCount = Math.max(1, Math.round(gauss(8, 5)));
    const session_id = Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 6);
    const project = pick(PROJECTS);
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
    return {
      tool: toolSpec.source === "claude_code" ? "claude" : toolSpec.source, // /api/sessions uses 'claude' as the tool key
      source: toolSpec.source,
      session_id,
      project,
      turns,
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
      // Skip ~12% of days entirely (vacation / quiet days).
      if (rand() < 0.12 * (dow === 0 ? 1.6 : 1)) continue;
      for (const tool of allTools) {
        const expected = tool.weight * 6.0 * weekend * recency; // sessions per tool per day
        const count = Math.max(0, Math.round(gauss(expected, expected * 0.6)));
        for (let i = 0; i < count; i++) sessions.push(makeSession(tool, dayMs));
      }
    }
  })();

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

  // ---------- /api/usage ----------
  function buildUsage(period, dateFrom, dateTo) {
    const range = periodToRange(period, dateFrom, dateTo);

    const byApp = {};         // source -> aggregate (incl. models map)
    const combinedModels = {}; // model name -> aggregate
    let total_tokens = 0, total_cost = 0, total_messages = 0;

    for (const { session, turn } of iterTurnsInRange(range)) {
      const src = session.source;
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
    }

    // Finalize apps -> { models: [...] }
    const apps = {};
    for (const [src, agg] of Object.entries(byApp)) {
      const models = Object.values(agg._models).sort((a, b) => b.cost - a.cost);
      delete agg._models;
      apps[src] = { ...agg, models };
    }

    const codingApps = {};
    for (const [src, v] of Object.entries(apps)) if (src !== "openclaw") codingApps[src] = v;

    const codingModels = [];
    for (const [src, v] of Object.entries(codingApps)) {
      for (const m of v.models) codingModels.push({ source: src, ...m });
    }
    codingModels.sort((a, b) => b.cost - a.cost);

    const openclawApp = apps.openclaw || { tokens: 0, tokens_in: 0, tokens_out: 0, tokens_cache: 0, cost: 0, messages: 0, models: [] };
    const openclawModels = openclawApp.models.map((m) => ({ ...m })).sort((a, b) => b.cost - a.cost);

    const by_tool = {};
    for (const [src, v] of Object.entries(apps)) {
      by_tool[src] = { tokens: v.tokens, cost: v.cost };
    }

    const combined = Object.values(combinedModels).sort((a, b) => b.cost - a.cost);

    // Comparison: previous window aggregates.
    const prev = previousRange(range);
    let p_tokens = 0, p_cost = 0, p_messages = 0;
    for (const { turn } of iterTurnsInRange(prev)) {
      p_tokens += turn.tokens; p_cost += turn.cost; p_messages += 1;
    }
    const pct = (cur, prv) => (prv === 0 ? null : Math.round(((cur - prv) / prv) * 1000) / 10);

    return {
      period: period || "today",
      total_tokens,
      total_cost: Math.round(total_cost * 100) / 100,
      total_messages,
      by_tool,
      apps: codingApps,
      coding_apps: codingApps,
      coding_models: codingModels,
      top_models: combined.slice(0, 5),
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
  // The session-explorer panel only knows about codex, claude, opencode.
  const SESSION_TOOL_KEYS = { codex: "codex", claude: "claude_code", opencode: "opencode" };
  const TOOL_LABELS = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };

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

    return {
      tool: session.tool,
      session_id: session.session_id,
      project: session.project,
      model: top_model,
      token_events: turns.length,
      tokens_in, tokens_cache, tokens_out, tokens_reasoning,
      tokens,
      cache_ratio: tokens > 0 ? tokens_cache / tokens : 0,
      cost,
      started_at: isoOf(turns[0].timestamp_ms),
      last_seen_at: isoOf(turns[turns.length - 1].timestamp_ms),
    };
  }

  function buildSessions(tool, period, dateFrom, dateTo) {
    const key = String(tool || "").toLowerCase();
    const internalSource = SESSION_TOOL_KEYS[key];
    if (!internalSource) return { __error: 400, message: `Unsupported session tool: ${tool}` };

    const range = periodToRange(period, dateFrom, dateTo);
    const matching = sessions.filter((s) => s.source === internalSource);

    const summaries = [];
    for (const s of matching) {
      const summary = summarizeSession(s, range);
      if (summary) summaries.push(summary);
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
      },
      timestamp: new Date().toISOString(),
    };
  }

  function buildSessionDetail(tool, sessionId) {
    const key = String(tool || "").toLowerCase();
    const internalSource = SESSION_TOOL_KEYS[key];
    if (!internalSource) return { __error: 400, message: `Unsupported session tool: ${tool}` };

    const found = sessions.find((s) => s.source === internalSource && s.session_id === sessionId);
    if (!found) return { __error: 404, message: `Session not found: ${sessionId}` };

    const session = summarizeSession(found, null);
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

  // ---------- /api/stats ----------
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
    const favorite_model =
      Object.entries(modelCosts).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    return {
      meta: { source: "merged" },
      summary: { totalTokens: total_tokens, totalCost: total_cost, activeDays: active_days, totalDays: total_days },
      contributions: dayList,
      stats: {
        favorite_model,
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
  async function loadPricingDb() {
    if (pricingCache) return pricingCache;
    const res = await origFetch("./pricing_db.json", { cache: "no-store" });
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

  async function dispatch(input, init) {
    const url = parseUrl(input);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return null; // not ours
    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    const params = url.searchParams;

    if (path === "/api/usage" && method === "GET") {
      return jsonResponse(buildUsage(params.get("period"), params.get("date_from"), params.get("date_to")));
    }
    if (path === "/api/sessions" && method === "GET") {
      const out = buildSessions(params.get("tool"), params.get("period"), params.get("date_from"), params.get("date_to"));
      if (out.__error) return jsonResponse({ detail: out.message }, out.__error);
      return jsonResponse(out);
    }
    if (path === "/api/session" && method === "GET") {
      const out = buildSessionDetail(params.get("tool"), params.get("session_id"));
      if (out.__error) return jsonResponse({ detail: out.message }, out.__error);
      return jsonResponse(out);
    }
    if (path === "/api/stats" && method === "GET") {
      const yr = params.get("year");
      return jsonResponse(buildStats(yr ? parseInt(yr, 10) : null));
    }
    if (path === "/api/pricing-db" && method === "GET") {
      return jsonResponse(await loadPricingDb());
    }
    if (path === "/api/pricing-db" && method === "PUT") {
      // Demo cannot persist edits — accept and echo back.
      const echoed = await loadPricingDb();
      return jsonResponse({ ...echoed, demo_note: "Edits are not persisted in the demo." });
    }
    if (path === "/api/openclaw" && method === "GET") {
      // Not consumed by the current UI but easy to support for parity.
      return jsonResponse({ total_tokens: 0, total_cost: 0, total_messages: 0, models: {} });
    }
    if (path === "/api/tools" && method === "GET") {
      return jsonResponse({ entries: [] });
    }
    if (path === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", demo: true });
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

  // Expose a tiny info API on the window for debugging / banner labels.
  window.__TOKDASH_DEMO__ = {
    sessionsCount: sessions.length,
    historyDays: HISTORY_DAYS,
    seed: 0x70B05A1,
  };
})();

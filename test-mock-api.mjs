/* Smoke-test the demo mock API outside the browser: stub a window, load
 * mock-api.js, and call every route the dashboard uses. Run: node test-mock-api.mjs */
import { readFileSync } from "node:fs";

const window = globalThis;
window.location = { origin: "http://localhost:8123", pathname: "/demo/" };
window.TOKDASH_BASE_PATH = "";
const origFetch = (input) => {
  // Pass-through fetch: only the site-root pricing snapshot is requested in tests.
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/pricing_db.json")) {
    const text = readFileSync(new URL("./pricing_db.json", import.meta.url), "utf8");
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { headers: { "Content-Type": "application/json" } });
};
window.fetch = origFetch;

const src = readFileSync(new URL("./static/mock-api.js", import.meta.url), "utf8");
new Function("window", src)(window);
const fetchMock = window.fetch;

const results = [];
async function get(path) {
  const res = await fetchMock(path);
  const body = await res.json();
  results.push([path, res.status, body]);
  return body;
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
}

// /api/usage
const usage = await get("/api/usage?period=week");
assert(usage.total_tokens > 0, "usage has tokens");
assert(usage.by_tool.dsh && usage.by_tool.mimo && usage.by_tool.zcode && usage.by_tool.workbuddy && usage.by_tool.qoder && usage.by_tool.qoder_cli, "usage includes dsh, mimo, zcode, workbuddy, qoder, and qoder_cli tools");
assert(usage.comparison && usage.comparison.tokens_pct !== undefined, "usage comparison present");

// /api/active-time (v1.7.0)
const active = await get("/api/active-time?period=week");
assert(active.active_ms > 0 && active.active_ms_sum >= active.active_ms, "active-time figures");
assert(active.by_tool.codex && active.by_tool.dsh && active.by_tool.zcode, "active-time by_tool has codex, dsh, and zcode");
assert(active.by_tool.codex.tool_label === "Codex", "active-time by_tool label");
assert(typeof active.comparison.active_ms_sum_pct === "number" || active.comparison.active_ms_sum_pct === null, "active-time comparison pct");
assert(active.active_gap_cap_ms === 300000, "active-time gap cap 300s");
const activeToday = await get("/api/active-time?period=today");
assert(activeToday.active_ms_sum > 0, "active-time today has agent time");

// /api/sessions for every session tool.
for (const tool of ["codex", "claude", "opencode", "pi_agent", "mimo", "kimi", "dsh", "reasonix", "zcode"]) {
  const s = await get(`/api/sessions?tool=${tool}&period=week`);
  assert(s.summary.session_count > 0, `sessions:${tool} has rows`);
  assert(s.summary.active_ms > 0 && s.summary.active_ms_sum > 0, `sessions:${tool} active time summary`);
  assert(s.summary.active_gap_cap_ms === 300000, `sessions:${tool} gap cap`);
  assert(s.sessions[0].active_ms !== undefined && s.sessions[0].span_ms !== undefined, `sessions:${tool} row runtime fields`);
  assert(!("_active_intervals" in s.sessions[0]), `sessions:${tool} strips private intervals`);
}
const badTool = await get("/api/sessions?tool=nope&period=week");
assert(results[results.length - 1][1] === 400, "sessions rejects unknown tool with 400");

// /api/session detail
const codexList = results.find(([p]) => p.startsWith("/api/sessions?tool=codex"))[2];
const detail = await get(`/api/session?tool=codex&session_id=${codexList.sessions[0].session_id}`);
assert(detail.session.active_ms > 0 && detail.turns.length > 0, "session detail runtime fields and turns");
assert(!("_active_intervals" in detail.session), "session detail strips private intervals");

// /api/activity-insights
const insights = await get("/api/activity-insights");
assert(insights.recorded_chats.value > 0, "insights recorded chats");
assert(insights.reasoning.distribution.length > 0 && insights.tools.distribution.length > 0, "insights distributions");
assert(insights.tools.most_used && insights.tools.most_used.name === "shell", "insights top tool");
const insights2 = await get("/api/activity-insights");
assert(JSON.stringify(insights.tools) === JSON.stringify(insights2.tools), "insights deterministic");

// /api/version (update-notice gating)
const version = await get("/api/version");
assert(version.service === "tokdash" && version.update_check_enabled === false, "version payload");

// /api/stats
const stats = await get("/api/stats");
assert(stats.contributions.length > 0 && stats.stats.favorite_model, "stats summary");

// pricing db passthrough shape (path resolves against the site root file)
const pricing = await get("/api/pricing-db");
assert(pricing.data && pricing.data.models && Object.keys(pricing.data.models).length > 300, "pricing-db snapshot loads");

console.log("\nDone.", process.exitCode ? "FAILURES ABOVE" : "All checks passed.");

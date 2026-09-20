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
// Every client the generator knows must reach /api/usage: a source that never
// lands in by_tool means the demo silently omits a client the app supports.
const demo = window.__TOKDASH_DEMO__;
const absent = demo.toolKeys.filter((tool) => !(usage.by_tool[tool] && usage.by_tool[tool].tokens > 0));
assert(absent.length === 0, `usage.by_tool serves every demo client (missing: ${absent.join(",")})`);
assert(usage.comparison && usage.comparison.tokens_pct !== undefined, "usage comparison present");

// /api/active-time (v1.7.0)
const active = await get("/api/active-time?period=week");
assert(active.active_ms > 0 && active.active_ms_sum >= active.active_ms, "active-time figures");
// by_tool carries exactly the tools with a session harness: the server builds it
// from SESSION_TOOLS, and the Report tab reads sessions/runtime out of it.
const activeTools = Object.keys(active.by_tool).sort().join(",");
assert(activeTools === [...demo.sessionTools].sort().join(","),
  `active-time by_tool matches the session tools (${activeTools})`);
assert(active.by_tool.codex.tool_label === "Codex", "active-time by_tool label");
assert(typeof active.comparison.active_ms_sum_pct === "number" || active.comparison.active_ms_sum_pct === null, "active-time comparison pct");
assert(active.active_gap_cap_ms === 300000, "active-time gap cap 300s");
const activeToday = await get("/api/active-time?period=today");
assert(activeToday.active_ms_sum > 0, "active-time today has agent time");

// /api/sessions for every session tool. The list comes from the mock itself, so a
// harness added upstream has to be mirrored in mock-api.js before this file can
// pass -- which is the whole point of the demo: it answers what the UI asks.
for (const tool of window.__TOKDASH_DEMO__.sessionTools) {
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


// /api/insights (the Report tab's facet scan)
const REPORT_FACETS = "daily,streaks,firsts,hourly,weekday,tools,models,projects";
const report = await get(`/api/insights?period=week&facets=${REPORT_FACETS}`);
assert(report.schema_version === 1 && report.facets.join(",") === REPORT_FACETS,
  "insights echoes the requested facets in caller order");
assert(report.range && report.range.from && report.range.to && report.range.days >= 1,
  "insights names the window it read");
assert(report.totals.tokens === usage.total_tokens && report.totals.messages === usage.total_messages,
  "insights totals agree with /api/usage for the same window");
const dailySum = report.daily.reduce((a, row) => a + row.tokens, 0);
assert(dailySum === report.totals.tokens, "daily facet sums to the scan total");
assert(report.daily.every((row, i) => (i === 0 || row.date > report.daily[i - 1].date)
  && row.intensity >= 1 && row.intensity <= 4), "daily rows are dated ascending with 1-4 intensity");
assert(report.hourly.buckets.length === 24 && report.hourly.night_hours.join(",") === "0,1,22,23"
  && report.hourly.peak_hour >= 0 && report.hourly.peak_hour <= 23,
  "hourly facet covers 24 hours and names the night window");
assert(report.weekday.buckets.length === 7 && report.weekday.buckets[0].name === "Monday",
  "weekday facet is Monday-first like the server");
assert(report.tools.ranked.length > 0
  && report.tools.ranked.every((row) => usage.by_tool[row.tool] !== undefined),
  "insights tool keys join the /api/usage rows the Report tab reads them from");
assert(report.models.ranked.every((row, i) => i === 0
  || report.models.ranked[i - 1].tokens >= row.tokens), "models ranked by tokens");
assert(report.models.most_used === report.models.ranked[0].model
  && typeof report.models.highest_cost === "string", "models facet names both podiums");
assert(report.projects.attributed_project_count > 0 && report.projects.names_included === true
  && report.projects.projects[0].project.length > 0, "projects facet keeps names by default");
assert(report.streaks.active_days === report.daily.length
  && report.streaks.longest_streak >= 1 && report.streaks.total_days >= report.streaks.active_days,
  "streaks facet agrees with the day count");
assert(report.firsts.first_active_day <= report.firsts.busiest_day
  && report.firsts.busiest_day_tokens > 0 && report.firsts.peak_hour !== undefined,
  "firsts facet names the busiest day and peak hour");

const anon = await get("/api/insights?period=week&facets=projects&include_project_names=false");
assert(anon.projects.names_included === false && anon.projects.projects[0].project === "project-1"
  && anon.projects.projects.length === anon.projects.attributed_project_count,
  "include_project_names=false anonymizes project rows in rank order");

const defaults = await get("/api/insights?period=week");
assert(defaults.daily === undefined && defaults.heatmap.cells.length === 168
  && defaults.facets.join(",") === "hourly,weekday,heatmap,models,tools,streaks,firsts",
  "omitted facets return the server default set, heatmap included");

const res400 = await fetchMock("/api/insights?facets=bogus");
const body400 = await res400.json();
assert(res400.status === 400 && /unknown facet/.test(body400.detail),
  "an unknown facet is refused with 400 rather than dropped");


// /api/quota (Quota tab): each fleet machine answers with its own provider set,
// every provider in a payload exists in the mock's catalog, and each bucket carries
// the fields the cards and charts read.
const QUOTA_BUCKET_FIELDS = ["account", "bucket", "bucket_label", "used_percent",
  "remaining_percent", "resets_at", "captured_at", "source", "status"];
const quotaByServer = {};
for (const server of demo.servers) {
  const quota = await (await fetchMock(`${server.baseUrl}/api/quota`)).json();
  quotaByServer[server.id] = Object.keys(quota.providers || {}).sort();
  assert(quotaByServer[server.id].length > 0, `quota:${server.id} reports at least one provider`);
  assert(quotaByServer[server.id].every((key) => demo.quotaProviders.includes(key)),
    `quota:${server.id} only reports catalogued providers`);
  for (const [key, provider] of Object.entries(quota.providers || {})) {
    assert(Array.isArray(provider.buckets) && provider.buckets.length > 0, `quota:${server.id}/${key} has buckets`);
    assert(QUOTA_BUCKET_FIELDS.every((field) => field in (provider.buckets[0] || {})),
      `quota:${server.id}/${key} bucket carries the fields the cards read`);
  }
}
assert(new Set(Object.values(quotaByServer).map((keys) => keys.join(","))).size === demo.servers.length,
  `each machine reports its own provider set (${JSON.stringify(quotaByServer)})`);
assert(quotaByServer.local.length === demo.quotaProviders.length,
  `the local machine reports every catalogued provider (${quotaByServer.local.length}/${demo.quotaProviders.length})`);
const go = (await (await fetchMock("/api/quota")).json()).providers.opencode_go;
assert(go && go.plan === "Go" && go.buckets.length === 3
  && go.buckets.map((b) => b.bucket).join(",") === "rolling,weekly,monthly",
  "OpenCode Go reports its three windows on the Go plan");

console.log("\nDone.", process.exitCode ? "FAILURES ABOVE" : "All checks passed.");

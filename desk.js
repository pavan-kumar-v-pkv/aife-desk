"use strict";
/*
 * AIFE Desk: the paper account, research and machines in one installable app.
 * Reads everything from GitHub (the paper-state branch and the repo itself) with the
 * user's own token, kept only on this device. Paper money only: there is no code
 * path from here to a broker. The only write is starting the paper-daily workflow.
 */

const APP_VERSION = "desk-app-v1";
const DEFAULT_REPO = "pavan-kumar-v-pkv/ai-investment-trading-engine";
const STATE_BRANCH = "paper-state";
const WORKFLOW = "paper-daily.yml";
const STALE_AFTER_MS = 5 * 60 * 1000;
const KEYS = { token: "aife.token", repo: "aife.repo", snapshot: "aife.snapshot", tab: "aife.tab" };

const saved = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: works without memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const ui = { tab: saved.get(KEYS.tab) || "desk", snap: null, loading: false, error: null,
             sort: { key: "value", dir: -1 }, orderFilter: "planned", runMessage: null };

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const N = (x) => (x === null || x === undefined || x === "" ? null : Number(x));
const inr0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isNum = (v) => typeof v === "number" && isFinite(v);
const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const rs = (v) => (isNum(v) ? (v < 0 ? "−" : "") + "₹" + inr0.format(Math.abs(v)) : "–");
const rs2 = (v) => (isNum(v) ? (v < 0 ? "−" : "") + "₹" + inr2.format(Math.abs(v)) : "–");
const rsSigned = (v) => (isNum(v) ? sign(v) + "₹" + inr0.format(Math.abs(v)) : "–");
const pct = (v, d = 2) => (isNum(v) ? sign(v) + Math.abs(v * 100).toFixed(d) + "%" : "–");
const pctPlain = (v, d = 1) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "–");
const tone = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
const day = (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–");
const dayShort = (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "–");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST" : "–");
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);

/* The newest weekday whose end-of-day file NSE should have published by now (same rule as the daily run). */
function expectedSession() {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const d = new Date(ist);
  if (ist.getHours() * 60 + ist.getMinutes() < 19 * 60 + 15) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- GitHub ---------- */
class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class GitHub {
  constructor(repo, token) { this.repo = repo; this.token = token; }

  async req(path, { method = "GET", raw = false, body } = {}) {
    let res;
    try {
      res = await fetch("https://api.github.com" + path, {
        method, cache: "no-store",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(0, "Can't reach GitHub. Check the internet connection.");
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch { /* not JSON */ }
      throw new GitHubError(res.status, detail || res.statusText);
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }

  file(path, ref = STATE_BRANCH) {
    const p = path.split("/").map(encodeURIComponent).join("/");
    return this.req(`/repos/${this.repo}/contents/${p}?ref=${encodeURIComponent(ref)}`, { raw: true });
  }
  async json(path, ref) { return JSON.parse(await this.file(path, ref)); }
  dir(path, ref = STATE_BRANCH) { return this.req(`/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`); }
  commits() { return this.req(`/repos/${this.repo}/commits?sha=${STATE_BRANCH}&per_page=15`); }
  runs() { return this.req(`/repos/${this.repo}/actions/workflows/${WORKFLOW}/runs?per_page=8`); }
  dispatch() { return this.req(`/repos/${this.repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main" } }); }
  check() { return this.req(`/repos/${this.repo}`); }
}

function explain(err, what) {
  if (!(err instanceof GitHubError)) return `${what}: ${err.message}`;
  if (err.status === 0) return err.message;
  if (err.status === 401) return "GitHub refused the token (expired or mistyped). Add a new one in System > Settings.";
  if (err.status === 403) return `${what}: the token doesn't have permission (${err.message}).`;
  if (err.status === 404) return `${what}: not found. Check the repository name and that the token can see it.`;
  return `${what}: GitHub said ${err.status} ${err.message}`;
}

function parseCloses(csv) {
  const out = {};
  for (const line of csv.trim().split("\n").slice(1)) {
    const [d, c] = line.split(",");
    if (d && c) out[d] = Number(c);
  }
  return out;
}

async function loadSnapshot(gh) {
  const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const [summary, account, index, statusDir, commits, runs, hyp] = await Promise.all([
    settle(gh.json("data/paper/summary.json")),
    settle(gh.json("data/paper/account.json")),
    settle(gh.file("data/cache/index/NIFTY_500.csv")),
    settle(gh.dir("data/status")),
    settle(gh.commits()),
    settle(gh.runs()),
    settle(gh.json("docs/hypotheses.json", "main")),
  ]);
  if (!summary.ok) throw summary.error;
  const statuses = {};
  if (statusDir.ok && Array.isArray(statusDir.value)) {
    const files = statusDir.value.filter((f) => f.name.endsWith(".json"));
    const loaded = await Promise.all(files.map((f) => settle(gh.json(f.path))));
    loaded.forEach((r, i) => { if (r.ok) statuses[files[i].name.replace(/\.json$/, "")] = r.value; });
  }
  return {
    loadedAt: Date.now(),
    repo: gh.repo,
    summary: summary.value,
    account: account.ok ? account.value : null,
    closes: index.ok ? parseCloses(index.value) : {},
    statuses,
    commits: commits.ok ? commits.value : [],
    runs: runs.ok ? runs.value.workflow_runs || [] : [],
    runsError: runs.ok ? null : explain(runs.error, "Workflow runs"),
    hypothesesFallback: hyp.ok ? hyp.value : null,
  };
}

/* ---------- derived views of the snapshot (display only) ---------- */
function latestStatus(snap) {
  const all = Object.values(snap.statuses || {});
  all.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
  return all[0] || null;
}
function proposals(snap) { return (snap.account?.proposals || snap.summary.proposals || []).slice(); }
function hypothesesOf(snap) {
  const st = latestStatus(snap);
  if (st?.project?.hypotheses?.hypotheses?.length) return st.project.hypotheses.hypotheses;
  return snap.hypothesesFallback?.hypotheses || [];
}
function recorderStatus(snap) {
  // only a machine that records quotes reports any; prefer the one with the most sealed days
  return Object.values(snap.statuses || {}).map((s) => s.project?.recorder).filter((r) => r && r.recorded_days > 0)
    .sort((a, b) => b.sealed_days - a.sealed_days)[0] || null;
}

/* ---------- small renderers ---------- */
const chip = (text, kind = "plain") => `<span class="chip ${kind}">${esc(text)}</span>`;
const statusChip = (status) => {
  const kind = { APPROVED: "good", FILLED: "plain", REJECTED_BY_RISK: "bad", REJECTED: "bad", PENDING: "warn" }[status] || "plain";
  const label = { APPROVED: "Planned", FILLED: "Filled", REJECTED_BY_RISK: "Blocked", REJECTED: "Rejected", PENDING: "Pending" }[status] || status;
  return chip(label, kind);
};
const verdictChip = (status) => chip(status, { "NO SIGNAL": "bad", "NOT SUPPORTED": "bad", "INSUFFICIENT DATA": "warn", SIGNAL: "good", SUPPORTED: "good" }[status] || "plain");
const bar = (fraction, cls = "") => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(1, fraction || 0)) * 100}%"></span></div>`;
const panel = (title, body, aside = "") => `<div class="panel"><h2><span>${esc(title)}</span>${aside ? `<span class="aside">${aside}</span>` : ""}</h2>${body}</div>`;
const kpi = (label, value, sub = "", cls = "", valueCls = "") =>
  `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value ${valueCls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;

function lineChart(series, { height = 220 } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) return `<div class="empty">The chart starts once the account has two sessions.</div>`;
  const W = 640, H = height, L = 46, R = 14, T = 12, B = 26;
  const dates = [...new Set(pts.map((p) => p[0]))].sort();
  const xi = Object.fromEntries(dates.map((d, i) => [d, i]));
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const padY = Math.max((hi - lo) * 0.15, 0.25);
  lo -= padY; hi += padY;
  const x = (d) => L + (dates.length === 1 ? 0 : (xi[d] / (dates.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = 4, grid = [];
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    grid.push(`<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
      `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v.toFixed(1)}</text>`);
  }
  const lines = series.map((s) => {
    if (s.points.length < 1) return "";
    const path = s.points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
    const last = s.points[s.points.length - 1];
    const area = s.area ? `<path d="${path} L${x(last[0]).toFixed(1)},${H - B} L${x(s.points[0][0]).toFixed(1)},${H - B} Z" fill="${s.color}" fill-opacity="0.08"/>` : "";
    return `${area}<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
  }).join("");
  const xl = `<text x="${L}" y="${H - 6}">${esc(dayShort(dates[0]))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(dayShort(dates[dates.length - 1]))}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Account value against the NIFTY 500, both starting at 100">${grid.join("")}${lines}${xl}</svg>`;
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }

/* ---------- views ---------- */
function viewDesk(snap) {
  const s = snap.summary;
  const equity = N(s.equity), cash = N(s.cash);
  const curve = (s.equity_curve || []).map(([d, e]) => [d, Number(e)]);
  const prev = curve.length > 1 ? curve[curve.length - 2][1] : null;
  const dayChange = prev ? equity - prev : null;
  const st = latestStatus(snap);
  const card = st?.scorecard;
  const since = N(s.return_since_start);
  const indexRet = card ? N(card.index_return) : null;

  const alerts = [];
  if (s.halted) alerts.push(`<div class="alert bad"><b>Trading halted.</b> ${esc(s.halt_reason || "The risk gate stopped new trades.")}</div>`);
  const expected = expectedSession();
  if (s.signal_day && s.signal_day < expected)
    alerts.push(`<div class="alert warn"><div><b>No run recorded for ${esc(day(expected))} yet</b> (unless it was a market holiday). The Mac runs at 19:30 and GitHub at 20:15, 22:00 and 07:00. You can start one from System.</div></div>`);
  const rec = recorderStatus(snap);
  if (rec?.missing_trading_days?.length)
    alerts.push(`<div class="alert warn"><div><b>Quote recorder missed ${rec.missing_trading_days.length} trading day${rec.missing_trading_days.length > 1 ? "s" : ""}:</b> ${esc(rec.missing_trading_days.map(dayShort).join(", "))}. Those quotes can't be recovered. Log in to FYERS on the Mac before 09:15 each trading day.</div></div>`);
  for (const n of s.notes || []) alerts.push(`<div class="alert info">${esc(n)}</div>`);

  const kpis = `<div class="kpis">
    ${kpi("Account value", rs(equity), dayChange !== null ? `<span class="${tone(dayChange)}">${rsSigned(dayChange)} (${pct(dayChange / prev)}) last session</span>` : "first session", "hero")}
    ${kpi("Since start", `<span class="${tone(since)}">${pct(since)}</span>`, indexRet !== null ? `NIFTY 500 <span class="${tone(indexRet)}">${pct(indexRet)}</span>` : `from ${rs(N(s.initial_capital))}`)}
    ${kpi("Drawdown", pct(-N(s.drawdown)), `peak ${rs(N(s.peak_equity))}`, "", N(s.drawdown) > 0 ? "down" : "")}
    ${kpi("Cash", rs(cash), `${pctPlain(cash / equity)} of the account`)}
    ${kpi("Holdings", String((s.positions || []).length), `costs paid ${rs(N(s.total_costs))}`)}
  </div>`;

  // account vs index, both rebased to 100 on the first day both exist
  const closes = snap.closes || {};
  const common = curve.filter(([d]) => closes[d]);
  const base = common[0];
  const series = [];
  if (base) {
    series.push({ name: "Account", color: cssVar("--accent"), area: true, points: common.map(([d, e]) => [d, (e / base[1]) * 100]) });
    series.push({ name: "NIFTY 500", color: cssVar("--brand"), points: common.map(([d]) => [d, (closes[d] / closes[base[0]]) * 100]) });
  } else if (curve.length) {
    series.push({ name: "Account", color: cssVar("--accent"), area: true, points: curve.map(([d, e]) => [d, (e / curve[0][1]) * 100]) });
  }
  const sessions = card ? card.sessions : curve.length;
  const reading = card?.reading || "TOO EARLY";
  const readingChip = chip(reading === "TOO EARLY" ? `Too early: ${sessions} of 60 sessions` : reading, reading === "AHEAD" ? "good" : reading === "BEHIND" ? "bad" : "warn");
  const chart = panel("Account vs NIFTY 500", `${lineChart(series)}
    <div class="inline" style="justify-content:space-between;margin-top:8px">
      <div class="legend">${series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join("")}</div>
      ${readingChip}
    </div>
    <div class="big-note" style="margin-top:8px">Both lines start at 100. A reading of ahead or behind counts only after 60 sessions, so a lucky week can't be over-read.</div>`,
    card ? `difference <span class="num ${tone(N(card.excess_return))}">${pct(N(card.excess_return))}</span>` : "");

  const planned = proposals(snap).filter((p) => p.signal_day === s.signal_day && p.status === "APPROVED");
  const orders = panel(`Next session's orders`, planned.length ? `<div class="rows">${planned.map((p) => `
      <div class="row"><div>${chip(p.side, p.side === "BUY" ? "good" : "bad")}</div>
        <div class="grow"><div class="title">${esc(p.symbol)}</div><div class="detail">${esc(p.reason)}</div></div>
        <div class="right num">${esc(p.quantity)} × ${rs2(N(p.reference_price))}<div class="detail">${rs(N(p.quantity) * N(p.reference_price))}</div></div>
      </div>`).join("")}</div>
      <div class="big-note" style="margin-top:6px">Filled at the next session's open. Planned on ${esc(day(s.signal_day))}.</div>`
    : `<div class="empty">No orders planned for the next session.</div>`, `${planned.length} planned`);

  const sv = s.surveillance || {};
  const market = panel("Market and strategy", `<div class="rows">
      <div class="row"><div class="grow"><div class="title">New buys</div><div class="detail">The market-breadth gate decides whether the strategy may buy.</div></div>
        <div class="right">${s.gate_open ? chip("Allowed", "good") : chip("Blocked", "bad")}</div></div>
      <div class="row"><div class="grow"><div class="title">Market breadth</div><div class="detail">Share of the ${esc(s.universe_size || 500)} stocks in an uptrend</div></div>
        <div class="right num">${pctPlain(N(s.breadth))}</div></div>
      <div class="row"><div class="grow"><div class="title">Surveillance lists</div><div class="detail">NSE ASM/GSM as of ${esc(dayShort(sv.as_of))}. Listed stocks are never bought.</div></div>
        <div class="right num">${Object.entries(sv.counts || {}).map(([k, v]) => `${esc(k.replace("_", " "))} ${esc(v)}`).join("<br>") || "–"}</div></div>
      <div class="row"><div class="grow"><div class="title">Strategy</div><div class="detail">${esc(s.strategy_id)}</div></div>
        <div class="right">${chip("Paper only", "warn")}</div></div>
    </div>`);

  return `${alerts.length ? `<div class="stack">${alerts.join("")}</div>` : ""}${kpis}
    <div class="grid">${chart}${orders}</div><div class="grid">${market}${journalSummary(snap)}</div>`;
}

function journalSummary(snap) {
  const realised = snap.account?.realised_by_year || {};
  const years = Object.entries(realised);
  const s = snap.summary;
  return panel("Tax and costs", `<div class="rows">
      <div class="row"><div class="grow"><div class="title">Realised gains</div><div class="detail">${years.length ? years.map(([fy, v]) => `${esc(fy)}: ${esc(rs(N(v?.total ?? v)))}`).join(", ") : "No closed trades yet"}</div></div></div>
      <div class="row"><div class="grow"><div class="title">Estimated tax on realised gains</div></div><div class="right num">${rs(N(s.estimated_tax_on_realised_gains))}</div></div>
      <div class="row"><div class="grow"><div class="title">Trading costs paid</div><div class="detail">Brokerage, STT, exchange and stamp charges</div></div><div class="right num">${rs2(N(s.total_costs))}</div></div>
    </div>`);
}

function viewBook(snap) {
  const s = snap.summary, equity = N(s.equity);
  const rows = (s.positions || []).map((p) => {
    const cost = N(p.cost_basis), value = N(p.value), gain = N(p.gain);
    return { symbol: p.symbol, sector: p.sector || "Unknown sector", qty: N(p.quantity), avg: cost / N(p.quantity),
             price: N(p.price), value, gain, gainPct: gain / cost, weight: value / equity,
             held: p.entry_day && s.signal_day ? daysBetween(p.entry_day, s.signal_day) : null, entry: p.entry_day };
  });
  const { key, dir } = ui.sort;
  rows.sort((a, b) => (typeof a[key] === "string" ? a[key].localeCompare(b[key]) : (a[key] ?? 0) - (b[key] ?? 0)) * dir);
  const tot = rows.reduce((t, r) => ({ value: t.value + r.value, gain: t.gain + r.gain, cost: t.cost + r.value - r.gain }), { value: 0, gain: 0, cost: 0 });
  const col = (k, label, cls = "") => `<th class="${cls}" data-act="sort" data-key="${k}" aria-sort="${key === k ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(label)}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`;
  const table = rows.length ? `<div class="tablewrap"><table>
      <thead><tr>${col("symbol", "Stock", "text")}${col("qty", "Qty")}${col("avg", "Avg cost")}${col("price", "Last")}${col("value", "Value")}${col("gain", "P&L")}${col("gainPct", "P&L %")}${col("weight", "Weight")}${col("held", "Held")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="sym">${esc(r.symbol)}</span><span class="sec">${esc(r.sector)}</span></td>
        <td class="num">${esc(r.qty)}</td><td class="num">${rs2(r.avg)}</td><td class="num">${rs2(r.price)}</td>
        <td class="num">${rs(r.value)}</td><td class="num ${tone(r.gain)}">${rsSigned(r.gain)}</td>
        <td class="num ${tone(r.gainPct)}">${pct(r.gainPct)}</td><td class="num">${pctPlain(r.weight)}</td>
        <td class="num" title="since ${esc(day(r.entry))}">${r.held === null ? "–" : esc(r.held) + "d"}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>${rows.length} holdings</td><td></td><td></td><td></td><td class="num">${rs(tot.value)}</td>
        <td class="num ${tone(tot.gain)}">${rsSigned(tot.gain)}</td><td class="num ${tone(tot.gain)}">${pct(tot.gain / tot.cost)}</td>
        <td class="num">${pctPlain(tot.value / equity)}</td><td></td></tr></tfoot></table></div>`
    : `<div class="empty">No holdings. The account is all cash.</div>`;

  const exposure = Object.entries(s.sector_exposure || {}).map(([k, v]) => [k, N(v)]).sort((a, b) => b[1] - a[1]);
  const cashShare = N(s.cash) / equity;
  const unknown = N((s.sector_exposure || {}).unknown) || 0;
  const largest = rows.reduce((m, r) => Math.max(m, r.weight), 0);
  const risk = panel("Sector exposure", `<div class="stack">
      ${exposure.map(([k, v]) => `<div><div class="inline" style="justify-content:space-between"><span>${esc(k === "unknown" ? "Sector not known" : k)}</span><span class="num">${pctPlain(v)}</span></div>${bar(v, k === "unknown" ? "brand" : "")}</div>`).join("")}
      <div><div class="inline" style="justify-content:space-between"><span>Cash</span><span class="num">${pctPlain(cashShare)}</span></div>${bar(cashShare)}</div>
    </div>
    ${unknown > 0.25 ? `<div class="alert warn" style="margin-top:12px">${pctPlain(unknown)} of the account is in stocks with no sector on file, so the sector cap can't check them.</div>` : ""}`);
  const conc = panel("Concentration", `<div class="rows">
      <div class="row"><div class="grow"><div class="title">Largest holding</div></div><div class="right num">${pctPlain(largest)}</div></div>
      <div class="row"><div class="grow"><div class="title">Holdings</div></div><div class="right num">${rows.length}</div></div>
      <div class="row"><div class="grow"><div class="title">Invested</div></div><div class="right num">${pctPlain(1 - cashShare)}</div></div>
      <div class="row"><div class="grow"><div class="title">Unrealised P&L</div></div><div class="right num ${tone(tot.gain)}">${rsSigned(tot.gain)}</div></div>
    </div>`);
  return `${panel("Holdings", table, `prices as of ${esc(day(s.signal_day))} close`)}<div class="grid">${risk}${conc}</div>`;
}

function viewOrders(snap) {
  const all = proposals(snap).sort((a, b) => b.signal_day.localeCompare(a.signal_day) || (a.rank ?? 999) - (b.rank ?? 999));
  const filters = { planned: (p) => p.status === "APPROVED", blocked: (p) => p.status.startsWith("REJECTED"),
                    filled: (p) => p.status === "FILLED", all: () => true };
  const counts = Object.fromEntries(Object.entries(filters).map(([k, f]) => [k, all.filter(f).length]));
  const labels = { planned: "Planned", blocked: "Blocked", filled: "Filled", all: "All" };
  const seg = `<div class="seg" role="group" aria-label="Filter orders">${Object.keys(filters).map((k) =>
    `<button type="button" data-act="filter" data-key="${k}" aria-pressed="${ui.orderFilter === k}">${labels[k]} <span class="num">${counts[k]}</span></button>`).join("")}</div>`;
  const shown = all.filter(filters[ui.orderFilter]);
  const byDay = {};
  for (const p of shown) (byDay[p.signal_day] ||= []).push(p);
  const groups = Object.entries(byDay).map(([d, ps]) => `<div class="panel"><h2><span>Signal of ${esc(day(d))}</span><span class="aside">${ps.length}</span></h2><div class="rows">
    ${ps.map((p) => {
      const ref = N(p.reference_price), fill = N(p.fill_price);
      const slip = fill && ref ? (fill - ref) / ref : null;
      const right = p.status === "FILLED"
        ? `${esc(p.quantity)} @ ${rs2(fill)}<div class="detail">${dayShort(p.fill_day)} · vs signal ${slip === null ? "–" : `<span class="${p.side === "BUY" ? tone(-slip) : tone(slip)}">${pct(slip)}</span>`}${p.realised_gain ? ` · P&L <span class="${tone(N(p.realised_gain))}">${rsSigned(N(p.realised_gain))}</span>` : ""}</div>`
        : `${N(p.quantity) ? esc(p.quantity) + " × " : ""}${rs2(ref)}`;
      return `<div class="row"><div>${chip(p.side, p.side === "BUY" ? "good" : "bad")}</div>
        <div class="grow"><div class="title">${esc(p.symbol)} ${statusChip(p.status)}</div>
          <div class="detail">${esc(p.reason)}${p.status_reason && p.status_reason !== "within every limit" ? ` · <b>${esc(p.status_reason)}</b>` : ""}</div></div>
        <div class="right num">${right}</div></div>`;
    }).join("")}</div></div>`).join("");
  const empty = `<div class="panel"><div class="empty">${{ planned: "Nothing planned for the next session.", blocked: "No orders blocked by the risk gate.", filled: "No fills yet.", all: "No orders yet." }[ui.orderFilter]}</div></div>`;
  return `<div class="inline" style="justify-content:space-between">${seg}<span class="muted" style="font-size:12.5px">Blocked = stopped by the risk gate, with the reason.</span></div>${groups || empty}`;
}

function viewResearch(snap) {
  const s = snap.summary;
  const held = new Set((s.positions || []).map((p) => p.symbol));
  const latest = Object.fromEntries(proposals(snap).filter((p) => p.signal_day === s.signal_day).map((p) => [p.symbol, p]));
  const top = (s.top_ranked || []).map((t, i) => {
    const p = latest[t.symbol];
    const state = held.has(t.symbol) ? chip("Held", "plain") : p ? statusChip(p.status) : "";
    return `<tr><td class="num">${i + 1}</td><td class="text"><span class="sym">${esc(t.symbol)}</span>${p?.status_reason && p.status.startsWith("REJECTED") ? `<span class="sec">${esc(p.status_reason)}</span>` : ""}</td>
      <td class="num up">${pct(N(t.score), 0)}</td><td class="num">${rs2(N(t.close))}</td><td>${state}</td></tr>`;
  }).join("");
  const signals = panel("Strongest momentum today", top
    ? `<div class="tablewrap"><table><thead><tr><th>#</th><th class="text">Stock</th><th>12-1 return</th><th>Close</th><th>Status</th></tr></thead><tbody>${top}</tbody></table></div>
       <div class="big-note" style="margin-top:8px">Ranked by return over the last 12 months excluding the latest month, among the ${esc(s.universe_size || 500)} most traded stocks. This ranking has not beaten the index in testing (H14), so the account trades it on paper only.</div>`
    : `<div class="empty">No ranking in this run.</div>`, esc(day(s.signal_day)));

  const hyps = hypothesesOf(snap);
  const counts = {};
  hyps.forEach((h) => { counts[h.status] = (counts[h.status] || 0) + 1; });
  const hypPanel = panel("Strategies tested", `<div class="inline" style="margin-bottom:8px">${Object.entries(counts).map(([k, v]) => `${verdictChip(k)}<span class="num muted">${v}</span>`).join(" ")}</div>
    <div class="rows">${hyps.map((h) => `<div class="row"><div class="num muted" style="width:34px">${esc(h.id)}</div>
      <div class="grow"><div class="title">${esc(h.name)}</div><div class="detail">${esc(h.why)}</div></div><div class="right">${verdictChip(h.status)}</div></div>`).join("")}</div>
    <div class="big-note" style="margin-top:8px">Each was written down before it was run, and none was changed after. None has beaten a NIFTY 500 index fund after costs and tax yet.</div>`,
    `${hyps.length} total`);

  const st = latestStatus(snap);
  const ready = st?.readiness;
  const readyPanel = panel("Live readiness", ready ? `<div style="margin-bottom:8px">${ready.verdict === "LIVE_READY" ? chip("Ready for live", "good") : chip("Live trading blocked", "bad")}</div>
    <div class="rows">${ready.checks.map((c) => `<div class="row"><div>${c.passed ? chip("Pass", "good") : chip("Not yet", "bad")}</div>
      <div class="grow"><div class="title">${esc(c.name.replaceAll("_", " "))}</div><div class="detail">${esc(c.detail)}</div></div></div>`).join("")}</div>`
    : `<div class="empty">Appears after the next daily run publishes a machine report.</div>`);

  const proj = st?.project;
  let planPanel = panel("Plan progress", `<div class="empty">Appears after the next daily run publishes a machine report.</div>`);
  if (proj?.milestones?.length) {
    const c = proj.milestone_counts, total = c.done + c.partial + c.open;
    const list = (state) => proj.milestones.filter((m) => m.state === state).map((m) => `<div class="row"><div class="grow"><div class="title">${esc(m.name)}</div><div class="detail">${esc(m.detail)}</div></div></div>`).join("");
    planPanel = panel("Plan progress", `<div class="split" aria-label="${c.done} done, ${c.partial} partly done, ${c.open} not built">
        <span style="width:${(c.done / total) * 100}%;background:var(--up)"></span><span style="width:${(c.partial / total) * 100}%;background:var(--warn)"></span><span style="width:${(c.open / total) * 100}%;background:var(--line)"></span></div>
      <div class="inline" style="margin:8px 0 4px">${chip(`${c.done} done`, "good")}${chip(`${c.partial} partly done`, "warn")}${chip(`${c.open} not built`, "plain")}</div>
      <div class="section-h" style="margin-top:12px">Partly done</div><div class="rows">${list("partial")}</div>
      <div class="section-h" style="margin-top:12px">Not built</div><div class="rows">${list("open")}</div>
      <details style="margin-top:8px"><summary>Done (${c.done})</summary><div class="rows">${list("done")}</div></details>`, `${total} items`);
  }
  return `<div class="grid">${signals}${hypPanel}</div><div class="grid">${readyPanel}${planPanel}</div>`;
}

function viewSystem(snap) {
  const runs = snap.runs || [];
  const runChip = (r) => r.status !== "completed" ? chip(r.status === "queued" ? "Queued" : "Running", "warn")
    : chip(r.conclusion === "success" ? "Succeeded" : r.conclusion || "done", r.conclusion === "success" ? "good" : "bad");
  const runPanel = panel("Daily run", `<div class="stack">
      <div class="big-note">Starts the daily paper run on GitHub, so it works with the Mac off. It takes 10 to 20 minutes. If the account already holds the latest session, the run checks and stops without changing anything.</div>
      <div class="inline"><button class="btn primary" type="button" data-act="run" id="run-btn">Run daily job now</button>
        ${ui.runMessage ? `<span class="muted" style="font-size:13px">${esc(ui.runMessage)}</span>` : ""}</div>
      ${snap.runsError ? `<div class="alert warn">${esc(snap.runsError)} The Run button needs a token with <b>Actions: Read and write</b>.</div>` : ""}
      <div class="rows">${runs.map((r) => `<div class="row"><div>${runChip(r)}</div>
        <div class="grow"><div class="title">${esc(r.event === "workflow_dispatch" ? "Started from the app or GitHub" : r.event === "schedule" ? "Scheduled" : r.event)}</div>
          <div class="detail">${esc(when(r.run_started_at || r.created_at))}${r.status === "completed" ? ` · ${Math.max(1, Math.round((new Date(r.updated_at) - new Date(r.run_started_at || r.created_at)) / 60000))} min` : ""}</div></div>
        <div class="right"><a href="${esc(r.html_url)}" target="_blank" rel="noopener noreferrer">Log</a></div></div>`).join("") || `<div class="empty">No runs to show.</div>`}</div>
    </div>`);

  const history = panel("Account history", `<div class="rows">${(snap.commits || []).map((c) => {
      const msg = c.commit?.message || "";
      const m = msg.match(/paper run (\S+) by (\S+)/);
      return `<div class="row"><div class="grow"><div class="title">${m ? `Session ${esc(day(m[1]))}` : esc(msg.split("\n")[0])}</div>
        <div class="detail">${esc(when(c.commit?.committer?.date))}</div></div><div class="right">${m ? chip(m[2], "plain") : ""}</div></div>`;
    }).join("") || `<div class="empty">No history.</div>`}</div>
    <div class="big-note" style="margin-top:6px">Whichever machine runs first records the session; the others see it's done and stop.</div>`);

  const machines = Object.values(snap.statuses || {}).sort((a, b) => a.runner.localeCompare(b.runner)).map((m) => {
    const rec = m.project?.recorder, data = m.project?.data || [];
    return panel(`Machine: ${m.runner}`, `<div class="big-note">Last report ${esc(when(m.generated_at))}</div>
      ${rec && rec.recorded_days > 0 ? `<div style="margin-top:10px"><div class="inline" style="justify-content:space-between"><b>Quote recorder</b><span class="num">${esc(rec.sealed_days)} of ${esc(rec.target_days)} days</span></div>${bar(rec.sealed_days / rec.target_days)}
        <div class="detail muted" style="margin-top:4px;font-size:12.5px">${rec.missing_trading_days.length ? `Missed: ${esc(rec.missing_trading_days.map(dayShort).join(", "))}` : "No missed trading days."} Last recorded ${esc(dayShort(rec.last))}.</div></div>` : ""}
      <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th class="text">Data on this machine</th><th>Amount</th><th>Newest</th></tr></thead><tbody>
        ${data.map((d) => `<tr><td class="text">${esc(d.name)}</td><td class="num">${esc(inr0.format(d.count))} ${esc(d.unit)}</td><td class="num">${esc(d.last ? dayShort(d.last) : "–")}</td></tr>`).join("")}
      </tbody></table></div>`);
  }).join("") || panel("Machines", `<div class="empty">Each machine adds a report after its next daily run.</div>`);

  const token = saved.get(KEYS.token) || "";
  const settings = panel("Settings", `<div class="rows">
      <div class="row"><div class="grow"><div class="title">Repository</div><div class="detail">${esc(snap.repo)}</div></div></div>
      <div class="row"><div class="grow"><div class="title">GitHub token</div><div class="detail num">${esc(token.slice(0, 11))}…${esc(token.slice(-4))} · stored on this device only</div></div>
        <div class="right inline"><button class="btn" type="button" data-act="change-token">Change</button><button class="btn" type="button" data-act="signout">Sign out</button></div></div>
      <div class="row"><div class="grow"><div class="title">App</div><div class="detail">${APP_VERSION} · paper money only, with no way to place real orders</div></div></div>
    </div>`);
  return `<div class="grid">${runPanel}${history}</div><div class="grid">${machines}</div>${settings}`;
}

function viewSetup(message = "") {
  const repo = saved.get(KEYS.repo) || DEFAULT_REPO;
  return `<form class="setup panel" id="setup-form" autocomplete="off">
    <h2><span>Connect to GitHub</span></h2>
    <div class="big-note">The Desk reads the paper account and research results from your private repository and can start the daily run. Your token stays on this device and is sent only to GitHub.</div>
    <ol>
      <li>On GitHub open Settings, Developer settings, Fine-grained tokens, Generate new token.</li>
      <li>Repository access: only <b>ai-investment-trading-engine</b>.</li>
      <li>Permissions: <b>Contents: Read-only</b> and <b>Actions: Read and write</b> (the second one is for the Run button).</li>
      <li>Copy the token and paste it below.</li>
    </ol>
    <div class="field"><label for="repo">Repository</label><input id="repo" name="repo" value="${esc(repo)}" spellcheck="false" autocapitalize="off"></div>
    <div class="field"><label for="token">Token</label><input id="token" name="token" type="password" placeholder="github_pat_..." spellcheck="false" autocapitalize="off" required>
      <div class="hint">Your existing token works for reading. Add Actions: Read and write to it to use the Run button.</div></div>
    ${message ? `<div class="alert bad">${esc(message)}</div>` : ""}
    <div><button class="btn primary" type="submit" id="connect-btn">Connect</button></div>
  </form>`;
}

/* ---------- shell ---------- */
const ICONS = {
  desk: '<path d="M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  book: '<path d="M3 7h18v13H3zM8 7V4h8v3M3 12h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  orders: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  research: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  system: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
const TABS = [["desk", "Desk"], ["book", "Book"], ["orders", "Orders"], ["research", "Research"], ["system", "System"]];
const VIEWS = { desk: viewDesk, book: viewBook, orders: viewOrders, research: viewResearch, system: viewSystem };
const $ = (id) => document.getElementById(id);

function render() {
  const connected = !!saved.get(KEYS.token);
  $("tabs").innerHTML = connected ? TABS.map(([k, label]) =>
    `<button class="tab" type="button" data-act="tab" data-key="${k}" ${ui.tab === k ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg><span>${label}</span></button>`).join("") : "";
  $("refresh").hidden = !connected;
  const snap = ui.snap;
  $("rail-foot").textContent = snap ? `Data from ${new Date(snap.loadedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "";
  $("refresh").classList.toggle("spin", ui.loading);
  if (!connected) {
    $("view-title").textContent = "AIFE Desk";
    $("meta").textContent = "";
    $("banner").innerHTML = "";
    $("view").innerHTML = viewSetup(ui.error || "");
    return;
  }
  $("view-title").textContent = TABS.find(([k]) => k === ui.tab)?.[1] || "Desk";
  $("meta").textContent = snap ? `Session ${dayShort(snap.summary.signal_day)} · updated ${ago(snap.loadedAt)}` : "";
  $("banner").innerHTML = ui.error ? `<div class="alert ${snap ? "warn" : "bad"}">${esc(ui.error)}${snap ? ` Showing data from ${esc(new Date(snap.loadedAt).toLocaleString("en-IN"))}.` : ""}</div>` : "";
  $("view").innerHTML = snap ? VIEWS[ui.tab](snap) : `<div class="panel"><div class="empty">${ui.loading ? "Loading the account from GitHub…" : "Nothing loaded yet."}</div></div>`;
}

async function refresh() {
  const token = saved.get(KEYS.token);
  if (!token || ui.loading) return;
  ui.loading = true; render();
  try {
    const snap = await loadSnapshot(new GitHub(saved.get(KEYS.repo) || DEFAULT_REPO, token));
    ui.snap = snap; ui.error = null;
    saved.set(KEYS.snapshot, JSON.stringify(snap));
  } catch (err) {
    ui.error = explain(err, "Loading the account");
  } finally {
    ui.loading = false; render();
  }
}

async function connect(form) {
  const repo = form.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const token = form.token.value.trim();
  const btn = $("connect-btn");
  btn.disabled = true; btn.textContent = "Checking…";
  try {
    await new GitHub(repo, token).check();
    saved.set(KEYS.repo, repo); saved.set(KEYS.token, token); saved.del(KEYS.snapshot);
    ui.error = null; ui.snap = null; ui.tab = "desk";
    render(); await refresh();
  } catch (err) {
    ui.error = explain(err, "Connecting"); render();
  }
}

async function startRun() {
  const btn = $("run-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
  try {
    await new GitHub(saved.get(KEYS.repo) || DEFAULT_REPO, saved.get(KEYS.token)).dispatch();
    ui.runMessage = "Started. It appears in the list within a minute; refresh to follow it.";
    setTimeout(refresh, 6000);
  } catch (err) {
    ui.runMessage = err instanceof GitHubError && err.status === 403
      ? "The token can't start runs. On GitHub, edit the token and set Actions to Read and write."
      : explain(err, "Starting the run");
  }
  render();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act, key = t.dataset.key;
  if (act === "tab") { ui.tab = key; saved.set(KEYS.tab, key); render(); window.scrollTo(0, 0); }
  else if (act === "sort") { ui.sort = { key, dir: ui.sort.key === key ? -ui.sort.dir : (key === "symbol" ? 1 : -1) }; render(); }
  else if (act === "filter") { ui.orderFilter = key; render(); }
  else if (act === "run") startRun();
  else if (act === "change-token" || act === "signout") {
    saved.del(KEYS.token); saved.del(KEYS.snapshot);
    ui.snap = null; ui.error = null; render();
  }
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "setup-form") { e.preventDefault(); connect(e.target); }
});
$("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!ui.snap || Date.now() - ui.snap.loadedAt > STALE_AFTER_MS)) refresh();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", render);

(function start() {
  try { ui.snap = JSON.parse(saved.get(KEYS.snapshot) || "null"); } catch { ui.snap = null; }
  if (!VIEWS[ui.tab]) ui.tab = "desk";
  render();
  refresh();
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* the app works without offline caching */ });
  }
})();

// Crosspost dashboard: library of X posts, composer with LinkedIn preview, queue, published.
const $ = id => document.getElementById(id);
const PAGE = 50;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK = 7 * 864e5;

const send = msg =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res && res.ok ? resolve(res.data) : reject(new Error(res ? res.error : "No response"));
    })
  );

const state = {
  posts: [],
  byId: new Map(),
  childOf: new Map(),
  liStatus: {},
  queue: [],
  settings: {},
  connected: false,
  li: null,
  xProfile: {},
  view: "review",
  rIdx: 0,
  skipped: new Set(),
  reviewOrder: "best",
  status: "open",
  sort: { key: "createdAt", dir: -1 },
  shown: PAGE,
  selected: new Set(),
  current: null,
  fillAt: null
};

// ---------- helpers ----------
const fmtNum = n => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n || 0));
const fmtDate = ts => {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
};
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const fmtWhen = ts => new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const bigImg = u => (u.includes("name=") ? u.replace(/name=\w+/, "name=large") : u + (u.includes("?") ? "&" : "?") + "name=large");
const smallImg = u => (u.includes("name=") ? u.replace(/name=\w+/, "name=small") : u + (u.includes("?") ? "&" : "?") + "name=small");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const icon = n => `<i data-i="${n}">${XLIIcons.svg(n)}</i>`.replace('<i data-i', '<i data-p="1" data-i');
const initials = s => (s || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setAvatar(el, url, name) {
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = initials(name);
  }
}
function threadOf(post) {
  const chain = [post];
  let cur = post;
  const seen = new Set([post.id]);
  while (state.childOf.has(cur.id)) {
    cur = state.childOf.get(cur.id);
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    chain.push(cur);
  }
  return chain;
}
const queuedFor = id => state.queue.find(q => q.tweetId === id);
const isPosted = id => state.liStatus[id]?.state === "posted";

function statusPill(id) {
  const q = queuedFor(id);
  if (q) {
    if (q.status === "failed") return `<span class="pill bad">${icon("alert")}Failed</span>`;
    if (q.status === "posting") return `<span class="pill sched">Posting…</span>`;
    return `<span class="pill sched" title="${esc(fmtWhen(q.at))}">${icon("clock")}${esc(shortWhen(q.at))}</span>`;
  }
  const s = state.liStatus[id];
  if (s?.state === "posted") return `<span class="pill ok">${icon("check")}Posted</span>`;
  if (s?.state === "failed") return `<span class="pill bad">${icon("alert")}Failed</span>`;
  return "";
}
const shortWhen = ts => XLISlots.label(ts); // "Today 9:17pm", "Tomorrow 9:04am", "Sun, Oct 4 · 9:17am"

// ---------- data ----------
async function load() {
  const d = await send({ type: "getDashboard" });
  Object.assign(state, {
    posts: d.posts,
    liStatus: d.liStatus,
    liposts: d.liposts || [],
    queue: d.queue,
    settings: d.settings,
    connected: d.connected,
    li: d.li,
    xProfile: d.xProfile || {}
  });
  state.byId = new Map(d.posts.map(p => [p.id, p]));
  const { skipped = [], reviewOrder = "best" } = await chrome.storage.local.get(["skipped", "reviewOrder"]);
  state.skipped = new Set(skipped);
  state.reviewOrder = reviewOrder;
  setTimeout(() => autoScreen(false), 1500);
  state.childOf = new Map();
  for (const p of d.posts) {
    if (p.kind !== "thread" || !p.parentId) continue;
    const prev = state.childOf.get(p.parentId);
    if (!prev || p.createdAt < prev.createdAt) state.childOf.set(p.parentId, p);
  }
  render();
}

// ---------- insights: did it reach people, when, what kind of post works, what to post next ----------
state.insPlat = "x";
state.insCell = null;
state.ideas = null;
const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n));
function insPosts(plat) {
  if (plat === "li") return state.liposts.map(p => ({ ...p, fit: fitOf(p).label }));
  return state.posts.filter(p => p.kind === "post" || p.kind === "quote").map(p => ({ ...p, isThread: state.childOf.has(p.id), fit: fitOf(p).label }));
}
function heatColor(score) {
  if (score == null) return "";
  // 1× (your usual) is the middle; stronger orange above, cool grey below
  const x = Math.max(-1, Math.min(1, Math.log2(score) / 1.6));
  return x >= 0 ? `color-mix(in oklab, #ff5a1f ${Math.round(18 + x * 82)}%, var(--surface))` : `color-mix(in oklab, #7d8aa6 ${Math.round(12 + -x * 40)}%, var(--surface))`;
}
function renderInsights() {
  document.querySelectorAll("#insSeg button").forEach(b => b.classList.toggle("on", b.dataset.p === state.insPlat));
  const plat = state.insPlat, posts = insPosts(plat), a = XLIInsights.analyze(posts), I = XLIInsights, box = $("ins");
  if (!a.count) {
    box.innerHTML = plat === "li"
      ? `<div class="calm"><h2>No LinkedIn numbers yet</h2><p>Crosspost reads reactions, comments and impressions from your LinkedIn activity page, right here in your browser. Nothing is sent anywhere.</p><div class="row center"><button class="btn primary" id="liRead"><i data-i="download"></i>Read my LinkedIn stats</button></div></div>`
      : `<div class="calm"><h2>Bring in your X posts first</h2><p>Crosspost learns what works from posts it has seen on X.</p><div class="row center"><button class="btn primary" id="insImport"><i data-i="download"></i>Import from X</button></div></div>`;
    XLIIcons.paint(box); bindIns(); return;
  }
  const M = a.metricLabel, r = a.reach;
  const order = [1, 2, 3, 4, 5, 6, 0];   // Monday first
  const rows = order.map(d => `<div class="hm-day">${I.DAYS[d]}</div>` + a.heat[d].map((c, h) =>
    `<button class="hm-c${c.n ? "" : " empty"}${state.insCell && state.insCell.d === d && state.insCell.h === h ? " sel" : ""}" data-d="${d}" data-h="${h}" style="${c.n ? "background:" + heatColor(c.score) : ""}" title="${I.DAYS[d]} ${I.hourLabel(h)} · ${c.n ? c.n + " post" + (c.n === 1 ? "" : "s") + " · " + I.times(c.score) + " your usual" : "no posts"}">${c.n > 1 ? c.n : ""}</button>`).join("")).join("");
  const hrs = `<div></div>` + Array.from({ length: 24 }, (_, h) => `<div class="hm-h">${h % 3 === 0 ? I.hourLabel(h) : ""}</div>`).join("");
  const sel = state.insCell ? a.heat[state.insCell.d][state.insCell.h] : null;
  const byId = new Map(posts.map(p => [p.id, p]));
  const line = (p, v) => `<a class="ins-post" href="${esc(p.url || "#")}" target="_blank" rel="noopener"><span class="ip-t">${esc((p.text || "").slice(0, 140))}</span><span class="ip-n">${fmtN(v)} ${M}</span><span class="ip-r ${p.rel >= 1 ? "up" : "down"}">${I.times(p.rel)}</span></a>`;
  const feat = a.features.slice(0, 8).map(f => { const w = Math.min(50, Math.abs(Math.log2(f.lift)) * 30); return `<div class="ft"><span class="ft-l">${esc(f.label)} <em>${f.n}</em></span><span class="ft-b"><i class="${f.lift >= 1 ? "up" : "down"}" style="${f.lift >= 1 ? "left:50%" : "right:50%"};width:${w}%"></i></span><span class="ft-v ${f.lift >= 1 ? "up" : "down"}">${I.times(f.lift)}</span></div>`; }).join("");
  const posted = new Set(Object.keys(state.liStatus).filter(id => state.liStatus[id]?.state === "posted"));
  const sug = I.suggest(a, { notOnLinkedIn: plat === "x" ? posts.map(p => p.id).filter(id => !posted.has(id)) : [] });
  box.innerHTML = `
    <div class="ins-kpis">
      <div><b>${fmtN(a.count)}</b><span>posts in the last year</span></div>
      <div><b>${fmtN(a.baseline)}</b><span>${M} on a usual post</span></div>
      <div><b>${r.recent ? fmtN(r.median) : "–"}</b><span>usual in the last 30 days${r.trend != null ? ` <em class="${r.trend >= 0 ? "up" : "down"}">${r.trend >= 0 ? "↑" : "↓"} ${Math.abs(r.trend)}%</em>` : ""}</span></div>
      <div><b>${r.beat != null ? r.beat + "%" : "–"}</b><span>of recent posts beat your usual</span></div>
    </div>
    ${a.metric === "eng" && plat === "x" ? `<p class="ins-note">No view counts yet, so this uses likes, reposts and replies. Views fill in as Crosspost sees your posts on X. <button class="linkbtn" id="insImport2">Refresh from X</button></p>` : ""}
    <section class="ins-card">
      <div class="ins-h"><h2>When your posts land</h2><span>Each square is an hour of the week, your time. Orange did better than your usual, grey did worse. Tap one to see the posts.</span></div>
      <div class="hm">${hrs}${rows}</div>
      <div class="hm-legend"><span>worse</span><i style="background:${heatColor(0.35)}"></i><i style="background:${heatColor(0.7)}"></i><i style="background:${heatColor(1)}"></i><i style="background:${heatColor(1.6)}"></i><i style="background:${heatColor(3)}"></i><span>better</span>
        ${a.slots.length ? `<span class="hm-best">Best: ${a.slots.map(x => `${I.DAYS[x.d]} ${I.hourLabel(x.h)} <em>${I.times(x.score)}</em>`).join(" · ")}</span>` : ""}</div>
      ${sel ? `<div class="ins-sel"><div class="ins-sub">${I.DAYS[state.insCell.d]} ${I.hourLabel(state.insCell.h)} · ${sel.n} post${sel.n === 1 ? "" : "s"}</div>${sel.ids.map(id => byId.get(id)).filter(Boolean).map(p => line({ ...p, rel: (p.views && a.metric === "views" ? p.views : p.likes + 2 * (p.reposts || 0) + 2 * (p.replies || p.comments || 0)) / a.baseline }, a.metric === "views" ? p.views : p.likes + 2 * (p.reposts || 0) + 2 * (p.replies || p.comments || 0))).join("")}</div>` : ""}
    </section>
    <div class="ins-grid">
      <section class="ins-card"><div class="ins-h"><h2>What kind of post works</h2><span>${M} compared with posts without it</span></div>${feat || '<p class="ins-note">Needs a few more posts to compare.</p>'}
        ${a.topics.length ? `<div class="ins-sub">Words in your best posts</div><div class="ins-chips">${a.topics.map(t => `<span class="ins-chip ${t.lift >= 1 ? "up" : ""}">${esc(t.t)} <em>${I.times(t.lift)}</em></span>`).join("")}</div>` : ""}</section>
      <section class="ins-card"><div class="ins-h"><h2>Did they reach people</h2><span>Your best posts, and the ones that didn't land</span></div>${a.top.map(p => line(p, p.value)).join("")}
        ${a.flops.length ? `<div class="ins-sub">Didn't land</div>${a.flops.map(p => line(p, p.value)).join("")}` : ""}</section>
    </div>
    <section class="ins-card">
      <div class="ins-h"><h2>What to post next</h2><span>From your own numbers</span></div>
      <ul class="ins-sug">${sug.map(x => `<li><i data-i="${x.kind === "time" ? "clock" : x.kind === "topic" ? "text" : x.kind === "repost" ? "send" : x.kind === "reach" ? "eye" : "sparkles"}"></i><span>${esc(x.text)}</span>${x.ids ? `<button class="btn sm" data-queue-ids="${esc(x.ids.join(","))}">Queue</button>` : ""}</li>`).join("")}</ul>
      <div class="row"><button class="btn" id="insIdeas"><i data-i="sparkles"></i>${state.ideas ? "5 more ideas" : "Get 5 post ideas from Claude"}</button>${plat === "li" ? `<button class="btn ghost" id="liRead"><i data-i="download"></i>Refresh LinkedIn stats</button>` : ""}</div>
      ${state.ideas ? `<div class="ideas">${state.ideas.map((x, i) => `<div class="idea"><div class="idea-w">${esc(x.idea)}${x.when ? ` <em>${esc(x.when)}</em>` : ""}</div><p>${esc(x.draft)}</p><div class="row"><button class="btn sm" data-copy="${i}">Copy</button><a class="btn sm ghost" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(x.draft)}">Post on X</a></div></div>`).join("")}</div>` : ""}
    </section>`;
  XLIIcons.paint(box); bindIns(a, posts);
}
function bindIns(a, posts) {
  const box = $("ins");
  box.querySelectorAll(".hm-c").forEach(b => b.onclick = () => { const d = +b.dataset.d, h = +b.dataset.h; state.insCell = state.insCell && state.insCell.d === d && state.insCell.h === h ? null : { d, h }; renderInsights(); });
  const imp = () => startImport();
  if ($("insImport")) $("insImport").onclick = imp;
  if ($("insImport2")) $("insImport2").onclick = imp;
  if ($("liRead")) $("liRead").onclick = async () => { try { await send({ type: "startLiImport" }); toast("Opened your LinkedIn activity. Leave it for a minute while it scrolls, then come back."); } catch (e) { toast(e.message); } };
  box.querySelectorAll("[data-queue-ids]").forEach(b => b.onclick = () => quickQueue(b.dataset.queueIds.split(",")));
  box.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(state.ideas[+b.dataset.copy].draft); toast("Copied"); } catch { toast("Couldn't copy"); } });
  if ($("insIdeas")) $("insIdeas").onclick = async () => {
    const btn = $("insIdeas"); btn.disabled = true; btn.textContent = "Thinking…";
    const I = XLIInsights, sug = I.suggest(a);
    const summary = `Platform: ${state.insPlat === "li" ? "LinkedIn" : "X"}. Usual post gets ${Math.round(a.baseline)} ${a.metricLabel}.\n` +
      `Best times: ${a.slots.map(x => I.DAYS[x.d] + " " + I.hourLabel(x.h) + " (" + I.times(x.score) + ")").join(", ") || "not enough data"}.\n` +
      `What works: ${a.features.slice(0, 5).map(f => f.label + " " + I.times(f.lift)).join("; ")}.\nTopics that land: ${a.topics.map(t => t.t).join(", ")}.\n` +
      `Notes: ${sug.map(x => x.text).join(" ")}\n\nBest posts:\n${a.top.map(p => "- (" + I.times(p.rel) + ") " + p.text.slice(0, 500)).join("\n")}\n\nPosts that didn't land:\n${a.flops.map(p => "- " + p.text.slice(0, 300)).join("\n")}`;
    try { const r = await send({ type: "postIdeas", summary }); if (!r) throw new Error("Claude didn't answer. Check your Anthropic key in Settings."); state.ideas = r; }
    catch (e) { toast(e.message || String(e)); }
    renderInsights();
  };
}
document.querySelectorAll("#insSeg button").forEach(b => b.addEventListener("click", () => { state.insPlat = b.dataset.p; state.insCell = null; state.ideas = null; renderInsights(); }));

// ---------- calendar: better times for what's already scheduled ----------
let xCache = null;
function xAnalysis() {
  const key = state.posts.length + ":" + state.posts.reduce((t, p) => t + (p.views || 0), 0);
  if (!xCache || xCache.key !== key) xCache = { key, a: XLIInsights.analyze(insPosts("x")) };
  return xCache.a;
}
// 9:00 -> 9:17: a steady minute per post, never a round number
function naturalMinute(seed) { let h = 2166136261; for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h = Math.imul(h ^ (h >>> 15), 2246822507); let m = 3 + ((h >>> 0) % 54); if (m % 5 === 0) m += 2; return m; }
function atHour(ts, hour, seed) { const d = new Date(ts); d.setHours(hour, naturalMinute(seed), 0, 0); return d.getTime(); }
function retimePlans() {
  const now = Date.now() + 5 * 60e3, a = xAnalysis();
  const future = state.queue.filter(q => q.status !== "posting" && q.status !== "posted" && q.at > now).sort((x, y) => x.at - y.at);
  // 1. same day and hour, natural minute
  const natural = future.filter(q => new Date(q.at).getMinutes() % 5 === 0).map(q => ({ qid: q.qid, at: atHour(q.at, new Date(q.at).getHours(), q.qid) })).filter(c => c.at > now);
  // 2. same day, that day's best hour (spread out so two posts don't land together)
  const perDay = [];
  if (a.count) {
    const used = [];
    for (const q of future) {
      const d = new Date(q.at), best = XLIInsights.bestHourOn(a, d.getDay());
      if (best == null) continue;
      let at = null;
      for (const off of [0, 1, -1, 2, -2, 3, 11, 12]) {
        const h = best + off; if (h < 6 || h > 23) continue;
        const t = atHour(q.at, h, q.qid);
        if (t > now && !used.some(u => Math.abs(u - t) < 50 * 60e3)) { at = t; break; }
      }
      if (at == null) continue;
      used.push(at);
      if (Math.abs(at - q.at) > 5 * 60e3) perDay.push({ qid: q.qid, at });
    }
  }
  // 3. everything, in the same order, into your best windows only
  const bw = XLIInsights.bestWindows(a, Math.max(1, Math.min(4, (XLISlots.parse(state.settings.slotTimes) || [1]).length)));
  let slots = [];
  if (bw && future.length) { try { slots = XLISlots.upcoming({ ...state.settings, slotTimes: bw.text, slotNatural: true }, [], future.length).map(x => x.at); } catch {} }
  const best = slots.length === future.length ? future.map((q, i) => ({ qid: q.qid, at: slots[i] })).filter(c => Math.abs(c.at - future.find(q => q.qid === c.qid).at) > 5 * 60e3) : [];
  return { natural, perDay, best, bw, a, total: future.length };
}
function renderRetime() {
  const p = retimePlans(), pop = $("rtPop"), I = XLIInsights;
  const opt = (k, title, sub, n) => `<button class="rt-opt" data-rt="${k}" ${n ? "" : "disabled"}><b>${title}</b><span>${sub}</span><span><em>${n ? n + " post" + (n === 1 ? "" : "s") + " move" : "Nothing to change"}</em></span></button>`;
  const noData = !p.a.count || !p.a.slots.length;
  pop.innerHTML =
    opt("natural", "Natural minutes", "Posts sitting on the hour (9:00) move to times like 9:17. Same day, same hour.", p.natural.length) +
    opt("perDay", "Each day's best hour", noData ? "Needs a few posts with views on X to know your best hours." : "Every post stays on its day and moves to the hour that does best on that day, from your heat map.", noData ? 0 : p.perDay.length) +
    opt("best", "Only my best windows", p.bw ? `Re-plans the whole queue, same order, into ${esc(p.bw.windows.map(w => I.hourLabel(w.h) + "–" + I.hourLabel((w.h + 2) % 24)).join(" and "))} on your posting days.` : "Needs a few posts with views on X to know your best hours.", p.bw ? p.best.length : 0);
  pop.querySelectorAll("[data-rt]").forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const changes = p[b.dataset.rt];
    pop.hidden = true;
    try {
      const r = await send({ type: "bulkRetime", changes });
      await load();
      toastUndo(`Moved ${r.changed} post${r.changed === 1 ? "" : "s"}`, async () => { await send({ type: "bulkRetime", changes: r.before }); await load(); });
    } catch (e) { toast(e.message); }
  });
}
$("rtBtn").onclick = ev => { ev.stopPropagation(); const pop = $("rtPop"); pop.hidden = !pop.hidden; if (!pop.hidden) renderRetime(); };
$("rtPop").onclick = ev => ev.stopPropagation();
document.addEventListener("click", () => { if ($("rtPop")) $("rtPop").hidden = true; });

// ---------- shell ----------
const VIEWS = ["review", "queue", "calendar", "published", "insights", "library"];
function go(view) {
  if (view === "settings") return openSettings();
  state.view = view;
  if (view !== "library") state.selected.clear();
  history.replaceState(null, "", "#" + view);
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".dock a").forEach(a => a.addEventListener("click", () => go(a.dataset.view)));
$("dockSettings").onclick = () => openSettings();
$("acctAv").onclick = () => openSettings();
$("brandBtn").onclick = () => go("review");
$("dockSearch").onclick = () => openCmd();
$("cmdBtn").onclick = () => openCmd();

function render() {
  document.querySelectorAll(".dock a").forEach(a => a.classList.toggle("on", a.dataset.view === state.view));
  for (const v of VIEWS) $("view-" + v).hidden = state.view !== v;
  $("nQueue").textContent = state.queue.length || "";
  renderAvatar();
  renderStatusLine();
  if (state.view === "review") renderReview();
  if (state.view === "library") renderLibrary();
  if (state.view === "queue") renderQueue();
  if (state.view === "published") renderPublished();
  if (state.view === "calendar") renderCalendar();
  if (state.view === "insights") renderInsights();
  renderBulk();
  if (state.current) renderComposerStatus();
}

function renderAvatar() {
  const li = state.li;
  setAvatar($("acctAv"), li?.picture || state.xProfile.avatar, li?.name || state.xProfile.name);
  $("acctAv").title = state.connected ? `${li?.name || "LinkedIn"} · Settings` : "Connect LinkedIn in Settings";
  $("acctAv").style.boxShadow = state.connected ? "" : "0 0 0 2px var(--bg), 0 0 0 4px var(--bad)";
}

// one quiet line of status instead of panels
async function renderStatusLine() {
  let r = state.rhythm;
  try {
    r = await send({ type: "rhythm" });
    state.rhythm = r;
  } catch {}
  const parts = [];
  if (!state.connected) parts.push(`<span class="warn">LinkedIn not connected</span>`);
  if (r) {
    if (r.runStart && r.weekIndex <= 12) parts.push(`<span>Week <b>${r.weekIndex || 1}</b> of 12</span>`);
    parts.push(`<span><b>${r.thisWeek.posted}/${r.target}</b> this week</span>`);
    parts.push(r.queueUntil ? `<span>Covered to <b>${new Date(r.queueUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b></span>` : `<span>Queue empty</span>`);
  }
  $("statusLine").innerHTML = parts.join(`<i class="dotsep"></i>`);
  if (state.view === "queue") renderRhythm();
}

// ---------- review: one post at a time ----------
const topics = () => String(state.settings.topics || "").split(",").map(s => s.trim()).filter(Boolean);
const fitOf = p => XLIParse.linkedinFit(p, topics());
const isPersonal = p => fitOf(p).label === "personal";

// Rank: work-related first, then engagement. Personal posts are never suggested (unless turned off in Settings).
function rankKey(p) {
  const f = fitOf(p);
  return (f.label === "work" ? 1000 : 0) + f.score * 3 + Math.log10((p.likes || 0) + 1) * 30 + Math.log10((p.views || 0) + 1) * 6;
}
function reviewList() {
  const hide = state.settings.hidePersonal !== false;
  const list = rootPosts().filter(
    p => p.kind === "post" && !queuedFor(p.id) && !isPosted(p.id) && !state.skipped.has(p.id) && (p.text || p.images?.length) && !(hide && isPersonal(p))
  );
  if (state.reviewOrder === "new") list.sort((a, b) => b.createdAt - a.createdAt);
  else list.sort((a, b) => rankKey(b) - rankKey(a));
  return list;
}

async function markFit(id, label, silent) {
  await send({ type: "setFit", id, label });
  const p = state.byId.get(id);
  if (p) label ? (p.fitOverride = label) : delete p.fitOverride;
  if (!silent)
    toastUndo(label === "personal" ? "Won't suggest this for LinkedIn" : "Marked as work", async () => {
      await send({ type: "setFit", id, label: null });
      if (p) delete p.fitOverride;
      render();
    });
  render();
}

// Let Claude judge the posts the quick check isn't sure about (runs quietly, once per session batch)
async function autoScreen(force) {
  if (state.screening || !state.settings.anthropicKey || state.settings.screenWithClaude === false) return;
  const cands = rootPosts()
    .filter(p => p.kind === "post" && !queuedFor(p.id) && !isPosted(p.id) && !p.fitOverride && !(p.fit && p.fit.by === "claude"))
    .map(p => ({ p, f: fitOf(p) }))
    .filter(x => force || (x.f.score > 25 && x.f.score < 75))
    .sort((a, b) => rankKey(b.p) - rankKey(a.p))
    .slice(0, 30);
  if (!cands.length) return force && toast("Nothing left to screen");
  state.screening = true;
  try {
    const r = await send({ type: "screenPosts", ids: cands.map(x => x.p.id) });
    if (force) toast(`Claude screened ${r.screened} posts`);
    if (r.screened) await load();
  } catch (e) {
    if (force) toast(e.message);
  } finally {
    state.screening = false;
  }
}

function nextSlotAt() {
  const [n] = XLISlots.upcoming(state.settings, state.queue, 1);
  return n && n.at;
}

function renderReview(anim) {
  const list = reviewList();
  const hasPosts = state.posts.length > 0;
  if (state.rIdx >= list.length) state.rIdx = Math.max(0, list.length - 1);
  const p = list[state.rIdx];
  $("rv").hidden = !p;
  $("rvEmpty").hidden = !!p;
  if (!p) {
    $("rvEmptyTitle").textContent = hasPosts ? "You're all caught up" : "Bring in your X posts";
    $("rvEmptyText").textContent = hasPosts
      ? "Everything's queued or posted. New posts from X show up here as you browse."
      : "Crosspost reads your profile once and saves your posts here. Then you review them one at a time.";
    $("importX").hidden = hasPosts;
    $("importArchiveBtn").hidden = hasPosts;
    renderCaughtUp(hasPosts);
    return;
  }
  $("rvMore").innerHTML = "";
  const thread = threadOf(p);
  $("rvCount").textContent = `${state.rIdx + 1} of ${fmtNum(list.length)}`;
  $("rvMeta").innerHTML = [
    `${fmtNum(p.likes)} likes`,
    p.views ? `${fmtNum(p.views)} views` : "",
    fmtDate(p.createdAt),
    thread.length > 1 ? `thread of ${thread.length}` : "",
    fitOf(p).label === "unclear" ? "might be personal" : ""
  ]
    .filter(Boolean)
    .map(s => `<span>${esc(s)}</span>`)
    .join("");
  const rvText = $("rvText");
  const totalLen = thread.reduce((n, x) => n + (x.text || "").length, 0);
  rvText.className = "rv-text" + (totalLen > 600 ? " xlong" : totalLen > 260 ? " long" : "");
  rvText.innerHTML = thread.map(x => `<div class="part">${esc(x.text)}</div>`).join("");
  rvText.scrollTop = 0;
  requestAnimationFrame(markScroll);
  const imgs = thread.flatMap(x => x.images || []).slice(0, 4);
  $("rvMedia").className = "rv-media n" + imgs.length;
  $("rvMedia").innerHTML = imgs.map(u => `<img src="${esc(bigImg(u))}" alt="" loading="lazy">`).join("");
  const at = nextSlotAt();
  $("rvQueueLbl").textContent = at ? `Queue · ${shortWhen(at)}` : "Queue";
  $("rvHint").innerHTML = `<kbd>←</kbd><kbd>→</kbd> browse <span class="sep"></span> <kbd>⌘K</kbd> everything else`;
  const card = $("rvCard");
  card.className = "rv-card";
  if (anim) {
    void card.offsetWidth;
    card.classList.add("in");
  }
  state.rCurrent = p.id;
}

function flyOut(dir) {
  return new Promise(res => {
    $("rvCard").classList.add("out-" + dir);
    setTimeout(res, 180);
  });
}

async function reviewQueue() {
  const id = state.rCurrent;
  if (!id || $("rv").hidden) return;
  const it = itemFor(id);
  if (tooLong(it)) return editLong(id, it);
  try {
    await flyOut("u");
    const r = await send({ type: "enqueue", items: [it] });
    toastUndo(`Queued for ${shortWhen(r.added[0].at)}`, async () => {
      await send({ type: "removeQueueItem", qid: r.added[0].qid });
      await load();
    });
    await load();
    renderReview(true);
  } catch (e) {
    toast(e.message);
    renderReview(true);
  }
}
async function reviewSkip() {
  const id = state.rCurrent;
  if (!id || $("rv").hidden) return;
  await flyOut("l");
  state.skipped.add(id);
  await chrome.storage.local.set({ skipped: [...state.skipped] });
  toastUndo("Skipped", async () => {
    state.skipped.delete(id);
    await chrome.storage.local.set({ skipped: [...state.skipped] });
    renderReview(true);
  });
  renderReview(true);
}
function reviewMove(delta) {
  const n = reviewList().length;
  if (!n) return;
  state.rIdx = (state.rIdx + delta + n) % n;
  renderReview(true);
}
$("rvQueue").onclick = reviewQueue;
$("rvSkip").onclick = reviewSkip;
$("rvEdit").onclick = () => state.rCurrent && openComposer(state.rCurrent);
$("rvPersonal").onclick = () => reviewPersonal();
async function reviewPersonal() {
  const id = state.rCurrent;
  if (!id || $("rv").hidden) return;
  await flyOut("l");
  await markFit(id, "personal");
  renderReview(true);
}
$("rvCard").onclick = () => state.rCurrent && openComposer(state.rCurrent);

function toastUndo(text, undo) {
  const t = $("toast");
  t.innerHTML = `<span></span>${undo ? `<button class="undo">Undo</button>` : ""}`;
  t.firstChild.textContent = text;
  t.style.pointerEvents = "auto";
  if (undo) t.querySelector(".undo").onclick = async () => {
    t.classList.remove("show");
    await undo();
  };
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => {
    t.classList.remove("show");
    t.style.pointerEvents = "none";
  }, 4000);
}

// ---------- settings sheet ----------
function openSettings() {
  if (!$("settingsFrame").src) $("settingsFrame").src = "options.html?embed=1";
  $("sheet").hidden = false;
  $("sheetScrim").hidden = false;
}
function closeSettings() {
  $("sheet").hidden = true;
  $("sheetScrim").hidden = true;
  load();
}
$("sheetClose").onclick = closeSettings;
$("sheetScrim").onclick = closeSettings;

// ---------- command palette ----------
const cmd = { items: [], idx: 0 };
function commands() {
  const c = [
    { t: "Review posts", s: "One at a time", i: "card", run: () => go("review") },
    { t: "Queue", s: `${state.queue.length} scheduled`, i: "queue", run: () => go("queue") },
    { t: "Calendar", s: "Month view of your content", i: "calendar", run: () => go("calendar") },
    { t: "Posted", i: "check", run: () => go("published") },
    { t: "Browse all posts", s: "Table with sorting and bulk queue", i: "library", run: () => go("library") },
    { t: "Import from X", s: "Scroll your profile", i: "download", run: startImport },
    { t: "Import X archive", s: "tweets.js", i: "file", run: () => $("archiveFile").click() },
    { t: state.reviewOrder === "new" ? "Review best posts first" : "Review newest posts first", i: "repeat", run: async () => {
      state.reviewOrder = state.reviewOrder === "new" ? "best" : "new";
      state.rIdx = 0;
      await chrome.storage.local.set({ reviewOrder: state.reviewOrder });
      go("review");
    } },
    { t: "Posting schedule", s: "Days, times, 12-week run", i: "clock", run: () => {
      go("queue");
      setTimeout(() => ($("schedPanel").hidden = false), 50);
    } },
    { t: "Settings", s: "LinkedIn, visuals, Claude", i: "sliders", run: openSettings }
  ];
  if (state.settings.anthropicKey) c.push({ t: "Screen posts with Claude", s: "Sort work from personal", i: "sparkles", run: () => autoScreen(true) });
  const nPersonal = rootPosts().filter(p => p.fitOverride === "personal").length;
  if (nPersonal) c.push({ t: `Review ${nPersonal} posts marked personal`, i: "undo", run: () => {
    $("fHidePersonal").checked = false;
    $("q").value = "";
    state.status = "all";
    go("library");
  } });
  if (state.skipped.size) c.push({ t: `Bring back ${state.skipped.size} skipped posts`, i: "undo", run: async () => {
    state.skipped.clear();
    await chrome.storage.local.set({ skipped: [] });
    go("review");
  } });
  return c;
}
function openCmd() {
  $("cmd").hidden = false;
  $("cmdScrim").hidden = false;
  $("cmdInput").value = "";
  renderCmd();
  setTimeout(() => $("cmdInput").focus(), 10);
}
function closeCmd() {
  $("cmd").hidden = true;
  $("cmdScrim").hidden = true;
  $("cmdInput").blur();
}
function renderCmd() {
  const q = $("cmdInput").value.trim().toLowerCase();
  const acts = commands().filter(c => !q || (c.t + " " + (c.s || "")).toLowerCase().includes(q));
  const posts = q.length >= 2 ? rootPosts().filter(p => p.text.toLowerCase().includes(q)).sort((a, b) => b.likes - a.likes).slice(0, 7) : [];
  cmd.items = [...acts, ...posts.map(p => ({ t: p.text.replace(/\s+/g, " "), s: `♥ ${fmtNum(p.likes)} · ${fmtDate(p.createdAt)}`, i: queuedFor(p.id) ? "clock" : isPosted(p.id) ? "check" : "text", run: () => openComposer(p.id), post: true }))];
  cmd.idx = Math.min(cmd.idx, Math.max(0, cmd.items.length - 1));
  if (!cmd.items.length) {
    $("cmdList").innerHTML = `<div class="cmd-empty">No matches</div>`;
    return;
  }
  let html = "";
  let sec = "";
  cmd.items.forEach((it, n) => {
    const s = it.post ? "Posts" : "Go to";
    if (s !== sec) {
      html += `<div class="cmd-sec">${s}</div>`;
      sec = s;
    }
    html += `<div class="cmd-item ${n === cmd.idx ? "on" : ""}" data-n="${n}">${icon(it.i)}<span class="t">${esc(it.t)}</span>${it.s ? `<span class="s">${esc(it.s)}</span>` : ""}</div>`;
  });
  $("cmdList").innerHTML = html;
  $("cmdList").querySelectorAll(".cmd-item").forEach(el => {
    el.onmousemove = () => {
      if (cmd.idx !== +el.dataset.n) {
        cmd.idx = +el.dataset.n;
        $("cmdList").querySelectorAll(".cmd-item").forEach(x => x.classList.toggle("on", x === el));
      }
    };
    el.onclick = () => runCmd(+el.dataset.n);
  });
}
function runCmd(n) {
  const it = cmd.items[n];
  closeCmd();
  if (it) it.run();
}
$("cmdInput").addEventListener("input", () => ((cmd.idx = 0), renderCmd()));
$("cmdInput").addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cmd.idx = (cmd.idx + (e.key === "ArrowDown" ? 1 : -1) + cmd.items.length) % Math.max(1, cmd.items.length);
    renderCmd();
    $("cmdList").querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter") runCmd(cmd.idx);
  if (e.key === "Escape") closeCmd();
});
$("cmdScrim").onclick = closeCmd;

// ---------- library ----------
function rootPosts() {
  return state.posts.filter(p => p.kind !== "retweet" && !(p.kind === "thread" && state.byId.has(p.parentId)));
}

function filteredPosts() {
  const q = $("q").value.trim().toLowerCase();
  const f = { images: $("fImages").checked, threads: $("fThreads").checked, replies: $("fReplies").checked, quotes: $("fQuotes").checked };
  const base = rootPosts().filter(p => {
    if (p.kind === "reply" && !f.replies) return false;
    if (p.kind === "quote" && !f.quotes) return false;
    if ($("fHidePersonal").checked && isPersonal(p) && !queuedFor(p.id) && !isPosted(p.id)) return false;
    if (f.images && !p.images?.length) return false;
    if (f.threads && !state.childOf.has(p.id)) return false;
    if (q && !p.text.toLowerCase().includes(q)) return false;
    return true;
  });
  const counts = { open: 0, queued: 0, posted: 0, all: base.length };
  for (const p of base) {
    if (queuedFor(p.id)) counts.queued++;
    else if (isPosted(p.id)) counts.posted++;
    else counts.open++;
  }
  const list = base.filter(p =>
    state.status === "all" ? true : state.status === "queued" ? !!queuedFor(p.id) : state.status === "posted" ? !queuedFor(p.id) && isPosted(p.id) : !queuedFor(p.id) && !isPosted(p.id)
  );
  const { key, dir } = state.sort;
  list.sort((a, b) => ((a[key] || 0) - (b[key] || 0)) * dir);
  return { list, counts };
}

function renderLibrary() {
  const { list, counts } = filteredPosts();
  const hasAny = state.posts.length > 0;
  $("table").hidden = !hasAny;
  for (const k of ["open", "queued", "posted", "all"]) $("c" + k[0].toUpperCase() + k.slice(1)).textContent = fmtNum(counts[k]);
  document.querySelectorAll("#statusSeg button").forEach(b => b.classList.toggle("on", b.dataset.s === state.status));
  document.querySelectorAll(".sortable").forEach(h => {
    h.classList.toggle("on", h.dataset.sort === state.sort.key);
    h.classList.toggle("asc", state.sort.dir === 1);
  });
  const nf = ["fImages", "fThreads", "fReplies", "fQuotes"].filter(id => $(id).checked).length + ($("fHidePersonal").checked ? 0 : 1);
  $("fCount").hidden = !nf;
  $("fCount").textContent = nf;

  $("fillBar").hidden = !state.fillAt;
  if (state.fillAt) $("fillText").textContent = `Pick a post for ${fmtWhen(state.fillAt)}`;

  const rows = $("rows");
  rows.innerHTML = "";
  if (hasAny && !list.length) rows.innerHTML = `<div class="noresult">Nothing here with these filters.</div>`;
  const frag = document.createDocumentFragment();
  for (const p of list.slice(0, state.shown)) {
    const thread = threadOf(p);
    const r = document.createElement("div");
    r.className = "tr" + (state.selected.has(p.id) ? " sel" : "");
    r.dataset.id = p.id;
    const tags = [
      thread.length > 1 ? `<span class="tag">${icon("thread")}Thread · ${thread.length}</span>` : "",
      p.kind === "reply" ? `<span class="tag">Reply</span>` : "",
      p.kind === "quote" ? `<span class="tag">Quote</span>` : "",
      p.hasVideo ? `<span class="tag">Video</span>` : "",
      p.images?.length > 1 ? `<span class="tag">${icon("image")}${p.images.length}</span>` : "",
      isPersonal(p) ? `<span class="tag">Personal</span>` : ""
    ].join("");
    r.innerHTML = `
      <div class="c-sel"><input type="checkbox" ${state.selected.has(p.id) ? "checked" : ""} aria-label="Select post"></div>
      <div class="c-post"><div class="post-cell">
        ${p.images?.length ? `<img class="thumb" loading="lazy" src="${esc(smallImg(p.images[0]))}" alt="">` : ""}
        <div class="post-txt"><p>${esc(p.text || "(no text)")}</p>${tags ? `<div class="post-meta">${tags}</div>` : ""}</div>
      </div></div>
      <div class="c-num">${fmtDate(p.createdAt)}</div>
      <div class="c-num">${fmtNum(p.likes)}</div>
      <div class="c-num">${p.views ? fmtNum(p.views) : "–"}</div>
      <div class="c-st">${statusPill(p.id)}</div>
      <div class="c-act">
        <button class="icon-btn" data-a="fit" title="${isPersonal(p) ? "Mark as work" : "Not for LinkedIn"}">${icon(isPersonal(p) ? "undo" : "x")}</button>
        <button class="icon-btn" data-a="queue" title="Add to queue">${icon("queue")}</button>
        <button class="icon-btn" data-a="open" title="Open">${icon("pencil")}</button>
      </div>`;
    r.querySelector("input").addEventListener("click", e => {
      e.stopPropagation();
      e.target.checked ? state.selected.add(p.id) : state.selected.delete(p.id);
      r.classList.toggle("sel", e.target.checked);
      renderBulk();
    });
    r.querySelector('[data-a="fit"]').addEventListener("click", e => {
      e.stopPropagation();
      markFit(p.id, isPersonal(p) ? "work" : "personal");
    });
    r.querySelector('[data-a="queue"]').addEventListener("click", e => {
      e.stopPropagation();
      quickQueue([p.id]);
    });
    r.addEventListener("click", () => openComposer(p.id));
    frag.appendChild(r);
  }
  rows.appendChild(frag);
  $("moreBtn").hidden = list.length <= state.shown;
  $("moreBtn").textContent = `Show ${Math.min(PAGE, list.length - state.shown)} more`;
  $("selAll").checked = list.length > 0 && list.slice(0, state.shown).every(p => state.selected.has(p.id));
}

function renderBulk() {
  const n = state.selected.size;
  $("bulk").hidden = n === 0 || state.view !== "library";
  $("bulkN").textContent = `${n} selected`;
}

const LI_MAX = 3000;
const tooLong = it => (it.text || "").length > LI_MAX;
// a post over LinkedIn's limit opens in the editor with a note, instead of being cut off without telling you
function editLong(id, it, at) {
  if (at) state.fillAt = at;
  openComposer(id);
  msg("bad", `This one is ${it.text.length.toLocaleString()} characters. LinkedIn allows 3,000, so trim it here, then queue or schedule it.`);
}
function itemFor(id) {
  const p = state.byId.get(id);
  const parts = threadOf(p);
  const imgs = parts.flatMap(x => x.images || []).slice(0, 9).map(bigImg);
  const visual = XLIParse.visualFor(state.settings.visualMode || "auto", imgs.length > 0);
  return {
    tweetId: id,
    text: parts.map(x => x.text).filter(Boolean).join("\n\n"),   // never cut silently: long posts go to the editor instead
    images: visual === "images" ? imgs : [],
    visual,
    cardData: visual === "card" ? XLIParse.cardDataFor({ ...p, images: (p.images || []).map(bigImg) }) : null
  };
}

async function quickQueue(ids) {
  try {
    const order = filteredPosts().list.map(p => p.id).filter(id => ids.includes(id));
    const all = (order.length ? order : ids).map(itemFor);
    const ok = all.filter(it => !tooLong(it)), long = all.length - ok.length;
    const tail = long ? ` ${long} ${long === 1 ? "is" : "are"} over LinkedIn's 3,000 characters and stayed out: open ${long === 1 ? "it" : "them"} to trim.` : "";
    if (!ok.length) return toast(`Nothing queued.${tail}`);
    const r = await send({ type: "enqueue", items: ok });
    state.selected.clear();
    await load();
    toast((r.added.length > 1 ? `Queued ${r.added.length}. First goes out ${shortWhen(r.added[0].at)}.` : `Queued for ${shortWhen(r.added[0].at)}.`) + tail);
  } catch (err) {
    toast(err.message);
  }
}

// toolbar
document.querySelectorAll("#statusSeg button").forEach(b =>
  b.addEventListener("click", () => {
    state.status = b.dataset.s;
    state.shown = PAGE;
    renderLibrary();
  })
);
document.querySelectorAll(".sortable").forEach(h =>
  h.addEventListener("click", () => {
    const k = h.dataset.sort;
    state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: -1 };
    renderLibrary();
  })
);
let qT;
$("q").addEventListener("input", () => {
  clearTimeout(qT);
  qT = setTimeout(() => {
    state.shown = PAGE;
    renderLibrary();
  }, 120);
});
["fImages", "fThreads", "fReplies", "fQuotes", "fHidePersonal"].forEach(id => $(id).addEventListener("change", () => ((state.shown = PAGE), renderLibrary())));
$("filterBtn").onclick = e => {
  e.stopPropagation();
  $("filterPop").hidden = !$("filterPop").hidden;
};
$("filterPop").addEventListener("click", e => e.stopPropagation());
document.addEventListener("click", () => {
  $("filterPop").hidden = true;
  $("schedPop").hidden = true;
  $("schedPanel").hidden = true;
});
$("schedBtn").onclick = e => {
  e.stopPropagation();
  $("schedPanel").hidden = !$("schedPanel").hidden;
  if (!$("schedPanel").hidden) renderRhythm();
};
$("schedPanel").addEventListener("click", e => e.stopPropagation());
$("moreBtn").onclick = () => ((state.shown += PAGE), renderLibrary());
$("selAll").addEventListener("change", e => {
  const ids = filteredPosts().list.slice(0, state.shown).map(p => p.id);
  ids.forEach(id => (e.target.checked ? state.selected.add(id) : state.selected.delete(id)));
  renderLibrary();
  renderBulk();
});
$("bulkClear").onclick = () => {
  state.selected.clear();
  renderLibrary();
  renderBulk();
};
$("bulkQueue").onclick = () => quickQueue([...state.selected]);
$("fillCancel").onclick = () => {
  state.fillAt = null;
  go("queue");
};

// all caught up: what's coming, what you skipped that did well, how far back your posts go
function renderCaughtUp(hasPosts) {
  const box = $("rvMore");
  $("rvEmpty").classList.toggle("has-more", !!hasPosts);
  if (!hasPosts) { box.innerHTML = ""; return; }
  const mine = state.posts.filter(p => p.kind === "post" || p.kind === "quote" || p.kind === "thread");
  const oldest = mine.reduce((m, p) => (p.createdAt && p.createdAt < m ? p.createdAt : m), Date.now());
  const since = new Date(oldest).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const next = state.queue.filter(q => q.status !== "posted").slice(0, 3);
  const a = XLIInsights.analyze(insPosts("x"));
  const relOf = new Map(); if (a.count) { const M = a.metric === "views" ? p => p.views || 0 : p => (p.likes || 0) + 2 * (p.reposts || 0) + 2 * (p.replies || 0); for (const p of mine) relOf.set(p.id, M(p) / a.baseline); }
  const good = [...state.skipped].map(id => state.byId.get(id)).filter(p => p && (relOf.get(p.id) || 0) >= 1.5).sort((x, y) => relOf.get(y.id) - relOf.get(x.id)).slice(0, 3);
  const best = a.slots && a.slots[0];
  box.innerHTML = `
    <div class="cu">
      <div class="cu-card"><div class="cu-h">Up next</div>${next.length ? next.map(q => `<div class="cu-row"><span class="cu-t">${esc(shortWhen(q.at))}</span><span class="cu-x">${esc((q.text || "").slice(0, 70))}</span></div>`).join("") : '<p class="cu-note">Nothing queued.</p>'}<button class="linkbtn" id="cuQueue">Open the queue</button></div>
      <div class="cu-card"><div class="cu-h">Skipped, but did well on X</div>${good.length ? good.map(p => `<div class="cu-row"><span class="cu-t up">${XLIInsights.times(relOf.get(p.id))}</span><span class="cu-x">${esc((p.text || "").slice(0, 70))}</span><button class="btn sm" data-unskip="${esc(p.id)}">Bring back</button></div>`).join("") : `<p class="cu-note">${state.skipped.size ? `Nothing you skipped beat your usual on X. ${state.skipped.size} skipped in total.` : "You haven't skipped anything."}</p>`}${state.skipped.size ? `<button class="linkbtn" id="cuUnskipAll">Bring back all ${state.skipped.size}</button>` : ""}</div>
      <div class="cu-card"><div class="cu-h">Your X posts</div><p class="cu-note">${mine.length.toLocaleString()} posts, back to ${esc(since)}. Older ones aren't here yet.</p><div class="row"><button class="btn sm" id="cuOlder"><i data-i="download"></i>Import older posts</button><button class="btn sm ghost" id="cuArchive">Import archive</button></div></div>
      <div class="cu-card"><div class="cu-h">What to post next</div><p class="cu-note">${best ? `Your best time is ${XLIInsights.DAYS[best.d]} ${XLIInsights.hourLabel(best.h)} (${XLIInsights.times(best.score)} your usual).` : "Insights shows what's working once you have a few posts with views."}</p><button class="btn sm" id="cuIdeas"><i data-i="sparkles"></i>See insights and ideas</button></div>
    </div>`;
  XLIIcons.paint(box);
  $("cuQueue").onclick = () => go("queue");
  $("cuOlder").onclick = () => startImport(true);
  $("cuArchive").onclick = () => $("archiveFile").click();
  $("cuIdeas").onclick = () => go("insights");
  if ($("cuUnskipAll")) $("cuUnskipAll").onclick = async () => { state.skipped.clear(); await chrome.storage.local.set({ skipped: [] }); renderReview(); };
  box.querySelectorAll("[data-unskip]").forEach(b => b.onclick = async () => { state.skipped.delete(b.dataset.unskip); await chrome.storage.local.set({ skipped: [...state.skipped] }); renderReview(); });
}

// import
async function startImport(older) {
  const r = await send({ type: "startImport", older: older === true });
  if (r.needsHandle) toast("Open x.com once so we can find your profile, then import again");
}
$("importX").onclick = () => startImport();
$("importArchiveBtn").onclick = () => $("archiveFile").click();
$("archiveFile").onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const handle = state.settings.myHandle || prompt("Your X handle (without @)?", "") || "";
    const posts = XLIParse.fromArchive(await f.text(), handle.toLowerCase()).filter(p => p.kind !== "retweet");
    let added = 0;
    for (let i = 0; i < posts.length; i += 500) added += (await send({ type: "savePosts", posts: posts.slice(i, i + 500) })).added;
    toast(`Imported ${fmtNum(added)} new posts`);
    load();
  } catch {
    toast("Couldn't read that file. Use data/tweets.js from the archive.");
  }
  e.target.value = "";
};

// ---------- queue ----------
// open slots from now on (objects from XLISlots: {at, dayStart, w, s, e})
function openSlots(days = 14) {
  const now = Date.now() + 60_000;
  return XLISlots.between(now, now + days * 864e5, state.settings).filter(sl => !XLISlots.taken(sl, state.queue));
}

// Map each upcoming open slot to a suggested imported-but-unposted post (best first, no repeats).
function suggestions(days = 70) {
  const open = openSlots(days).map(sl => sl.at);
  const pool = reviewList();
  const map = new Map();
  open.forEach((t, i) => pool[i] && map.set(t, pool[i]));
  return map;
}

async function acceptSuggestion(at, id) {
  const it = itemFor(id);
  if (tooLong(it)) return editLong(id, it, at);
  try {
    await send({ type: "enqueue", items: [{ ...it, at }] });
    await load();
    toastUndo(`Scheduled for ${shortWhen(at)}`, async () => {
      const q = state.queue.find(x => x.tweetId === id);
      if (q) await send({ type: "removeQueueItem", qid: q.qid });
      await load();
    });
  } catch (e) {
    toast(e.message);
  }
}
async function passSuggestion(id) {
  state.skipped.add(id);
  await chrome.storage.local.set({ skipped: [...state.skipped] });
  render();
}

function renderQueue() {
  state.sugg = suggestions();
  renderRhythm();
  renderSchedule();

  const items = [...state.queue].sort((a, b) => a.at - b.at);
  const entries = [...items.map(q => ({ at: q.at, q })), ...openSlots().map(sl => ({ at: sl.at, empty: true }))].sort((a, b) => a.at - b.at);

  const list = $("queueList");
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="calm" style="padding-top:12vh"><h2>Nothing scheduled</h2><p>Open Schedule to pick your days and times, then queue posts from Review.</p></div>`;
    return;
  }
  let lastDay = "";
  const today = new Date().toDateString();
  const tmr = new Date(Date.now() + 864e5).toDateString();
  for (const e of entries) {
    const d = new Date(e.at);
    const key = d.toDateString();
    if (key !== lastDay) {
      const h = document.createElement("div");
      h.className = "day-h";
      const label = key === today ? "Today" : key === tmr ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "long" });
      h.innerHTML = `<b>${label}</b><span>${d.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span>`;
      list.appendChild(h);
      lastDay = key;
    }
    const row = document.createElement("div");
    row.className = "slot";
    row.dataset.at = e.at;
    if (e.q) row.dataset.qid = e.q.qid;
    row.innerHTML = `<div class="slot-t">${fmtTime(e.at)}</div>`;
    row.appendChild(e.empty ? emptySlot(e.at) : queueCard(e.q));
    list.appendChild(row);
    dropTarget(row, () => ({ at: e.at, qid: e.q && e.q.qid }));
  }
}

function emptySlot(at) {
  const p = state.sugg && state.sugg.get(at);
  const el = document.createElement("div");
  el.className = "slot-open" + (p ? " has-sugg" : "");
  if (!p) {
    el.innerHTML = `<span class="so-empty">Open slot</span><button class="btn sm ghost" data-a="pick">Pick a post</button>`;
  } else {
    const img = (p.images || [])[0];
    el.innerHTML = `
      <div class="so-body">
        <p>${esc(p.text)}</p>
        <small><b>Suggested</b> · ${fmtNum(p.likes)} likes · ${fmtDate(p.createdAt)}</small>
      </div>
      ${img ? `<img src="${esc(smallImg(img))}" alt="">` : ""}
      <div class="so-act">
        <button class="icon-btn" data-a="pass" title="Not for LinkedIn (won't suggest again)">${icon("x")}</button>
        <button class="btn sm" data-a="edit">Edit</button>
        <button class="btn sm primary" data-a="add">Add</button>
      </div>`;
    el.querySelector('[data-a="add"]').onclick = () => acceptSuggestion(at, p.id);
    el.querySelector('[data-a="pass"]').onclick = () => markFit(p.id, "personal");
    el.querySelector('[data-a="edit"]').onclick = () => {
      state.fillAt = at;
      openComposer(p.id);
    };
  }
  const pick = el.querySelector('[data-a="pick"]');
  if (pick) pick.onclick = () => {
    state.fillAt = at;
    state.status = "open";
    go("library");
  };
  return el;
}

function queueCard(q) {
  const p = state.byId.get(q.tweetId);
  const el = document.createElement("div");
  el.className = "qcard";
  const thumb = q.visual === "images" && q.images?.length ? `<img src="${esc(smallImg(q.images[0]))}" alt="">` : q.visual === "card" ? `<img data-card alt="">` : "";
  const visLabel = q.visual === "card" ? `${icon("card")}Tweet card` : q.visual === "images" && q.images?.length ? `${icon("image")}${q.images.length} image${q.images.length > 1 ? "s" : ""}` : `${icon("text")}Text only`;
  el.innerHTML = `
    <div class="qcard-b"><p>${esc(q.text)}</p>${thumb}</div>
    ${q.error ? `<div class="err">${esc(q.error)}</div>` : ""}
    <div class="qcard-f">
      <div class="meta">${q.status === "failed" ? `<span class="pill bad">${icon("alert")}Failed</span>` : q.status === "posting" ? `<span class="pill sched">Posting…</span>` : ""}<span class="tag">${visLabel}</span></div>
      ${p ? `<button class="btn sm ghost" data-a="edit">${icon("pencil")}Edit</button>` : ""}
      <div class="pop-wrap">
        <button class="btn sm ghost" data-a="move">${icon("clock")}Move</button>
        <div class="pop up move-pop" hidden>
          <button class="opt-btn" data-m="next">Next open slot</button>
          <label class="lbl">Or pick a time</label>
          <input class="input" type="datetime-local" data-m="at">
          <button class="btn sm primary block" data-m="set">Move here</button>
        </div>
      </div>
      <button class="btn sm ghost" data-a="now">${icon("send")}Post now</button>
      <button class="btn sm ghost danger" data-a="rm" title="Take it out of the queue. It goes back to Review.">${icon("x")}Unqueue</button>
    </div>`;
  el.draggable = true;
  el.title = "Drag onto another slot to move it";
  el.addEventListener("dragstart", ev => {
    ev.dataTransfer.setData("text/xli-qid", q.qid);
    ev.dataTransfer.effectAllowed = "move";
    document.body.classList.add("dragging");
  });
  el.addEventListener("dragend", () => document.body.classList.remove("dragging"));
  const pop = el.querySelector(".move-pop");
  el.querySelector('[data-a="move"]').onclick = ev => {
    ev.stopPropagation();
    document.querySelectorAll(".move-pop").forEach(x => x !== pop && (x.hidden = true));
    pop.querySelector('[data-m="at"]').value = toLocalInput(q.at);
    pop.hidden = !pop.hidden;
  };
  pop.addEventListener("click", ev => ev.stopPropagation());
  pop.querySelector('[data-m="next"]').onclick = async () => {
    try {
      const r = await send({ type: "bumpQueueItem", qid: q.qid });
      toast(`Moved to ${shortWhen(r.at)}`);
    } catch (err) {
      toast(err.message);
    }
    load();
  };
  pop.querySelector('[data-m="set"]').onclick = async () => {
    const at = new Date(pop.querySelector('[data-m="at"]').value).getTime();
    if (!at || at < Date.now() + 30_000) return toast("Pick a time in the future.");
    await moveQueued(q.qid, at);
  };
  if (q.visual === "card" && q.cardData) {
    send({ type: "renderCard", cardData: q.cardData }).then(r => (el.querySelector("[data-card]").src = r.dataUrl)).catch(() => {});
  }
  el.querySelector('[data-a="rm"]').onclick = () => unqueue(q);
  el.querySelector('[data-a="now"]').onclick = async e => {
    const b = e.currentTarget;
    b.disabled = true;
    b.lastChild.textContent = "Posting…";
    try {
      await send({ type: "postNow", tweetId: q.tweetId, text: q.text, images: q.images, visual: q.visual, cardData: q.cardData });
      toast("Posted to LinkedIn");
    } catch (err) {
      toast("Failed: " + err.message);
    }
    load();
  };
  const edit = el.querySelector('[data-a="edit"]');
  if (edit) edit.onclick = () => openComposer(q.tweetId);
  return el;
}

// take a post out of the queue (it shows up in Review again), with undo
async function unqueue(q) {
  await send({ type: "removeQueueItem", qid: q.qid });
  await load();
  toastUndo("Unqueued. It's back in Review.", async () => {
    await send({ type: "enqueue", items: [{ tweetId: q.tweetId, text: q.text, images: q.images, visual: q.visual, cardData: q.cardData, at: q.at }] });
    await load();
  });
}
async function moveQueued(qid, at) {
  const q = state.queue.find(x => x.qid === qid);
  const from = q && q.at;
  try {
    await send({ type: "updateQueueItem", qid, patch: { at } });
    await load();
    toastUndo(`Moved to ${shortWhen(at)}`, from ? async () => {
      await send({ type: "updateQueueItem", qid, patch: { at: from } });
      await load();
    } : null);
  } catch (e) {
    toast(e.message);
  }
}
// something you can drop a queued post on. target() -> {at, qid?}: a slot time, or another post to trade places with
let dragQid = null;
document.addEventListener("dragstart", ev => {
  const el = ev.target.closest && ev.target.closest("[data-qid]");
  dragQid = el ? el.dataset.qid : null;
});
document.addEventListener("dragend", () => {
  dragQid = null;
  document.querySelectorAll(".drop-on").forEach(x => x.classList.remove("drop-on"));
});
function dropTarget(el, target) {
  el.addEventListener("dragover", ev => {
    if (!ev.dataTransfer.types.includes("text/xli-qid")) return;
    const t = target();
    if (!t || (!t.qid && t.at < Date.now() + 60_000)) return;
    ev.preventDefault();
    ev.stopPropagation(); // the innermost target wins (a slot inside a calendar day)
    el.classList.add("drop-on");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-on"));
  el.addEventListener("drop", async ev => {
    el.classList.remove("drop-on");
    const qid = ev.dataTransfer.getData("text/xli-qid");
    const t = target();
    if (!qid || !t) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (t.qid === qid) return;
    if (t.qid) {
      await send({ type: "swapQueueItems", a: qid, b: t.qid });
      await load();
      toastUndo("Swapped", async () => {
        await send({ type: "swapQueueItems", a: qid, b: t.qid });
        await load();
      });
    } else await moveQueued(qid, t.at);
  });
}
document.addEventListener("click", () => document.querySelectorAll(".move-pop").forEach(x => (x.hidden = true)));

function renderRhythm() {
  const r = state.rhythm;
  if (!r) return;
  const short = d => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("rWeek").textContent = `${r.thisWeek.posted}/${r.target}`;
  $("rStreak").textContent = r.streak;
  $("rUntil").textContent = r.queueUntil ? short(r.queueUntil) : "–";
  $("runBtn").textContent = r.runStart ? "Restart" : "Start run";
  $("runTitle").textContent = !r.runStart ? "12-week run" : r.weekIndex > 12 ? "Run finished" : `Week ${r.weekIndex || 1} of 12`;
  $("rWeeks").innerHTML = (r.runStart ? r.weeks : Array.from({ length: 12 }, () => ({ state: "future", count: 0 })))
    .map((w, i) => {
      const fill = w.state === "current" ? Math.min(100, Math.round((w.count / r.target) * 100)) : 0;
      return `<div class="wk ${w.state}" style="--fill:${fill}%" title="${w.start ? `Week ${i + 1} · ${short(w.start)} · ${w.count}/${r.target} posted` : `Week ${i + 1}`}"></div>`;
    })
    .join("");
  const gap = r.target - r.thisWeek.posted - r.thisWeek.queued;
  $("rNudge").textContent = !r.runStart
    ? "Hold one rhythm for 12 weeks before you judge the numbers."
    : gap > 0
    ? `${gap} more to queue this week to hit ${r.target}.`
    : r.nextWeekQueued < r.target
    ? `This week is covered. Next week has ${r.nextWeekQueued} of ${r.target}.`
    : "This week and next are covered.";
}

function renderSchedule() {
  const s = state.settings;
  const wins = XLISlots.parse(s.slotTimes) || [];
  if (document.activeElement !== $("slotTimes")) $("slotTimes").value = s.slotTimes || XLISlots.DEFAULT_TIMES;
  $("perDay").querySelectorAll("button").forEach(b => b.classList.toggle("on", +b.dataset.n === wins.length));
  $("slotNatural").checked = s.slotNatural !== false;
  const bw = XLIInsights.bestWindows(xAnalysis(), Math.max(1, Math.min(4, wins.length || 1)));
  $("schedBest").hidden = !bw;
  if (bw) {
    const same = (s.slotTimes || "").replace(/\s/g, "") === bw.text.replace(/\s/g, "");
    $("schedBest").innerHTML = `<span>From your heat map: ${esc(bw.windows.map(w => XLIInsights.hourLabel(w.h) + "–" + XLIInsights.hourLabel((w.h + 2) % 24)).join(", "))}</span>${same ? "<em>in use</em>" : '<button class="linkbtn" id="useBest">Use my best times</button>'}`;
    if ($("useBest")) $("useBest").onclick = () => saveSchedule({ slotTimes: bw.text, slotNatural: true }, "Posting at your best times now");
  }
  const days = new Set((s.slotDays || []).map(Number));
  $("slotDays").innerHTML = "";
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const b = document.createElement("div");
    b.className = "day" + (days.has(d) ? " on" : "");
    b.textContent = DAY[d].slice(0, 2);
    b.title = DAY[d];
    b.onclick = () => {
      days.has(d) ? days.delete(d) : days.add(d);
      saveSchedule({ slotDays: [...days] });
    };
    $("slotDays").appendChild(b);
  }
  const n = XLISlots.perWeek(s);
  $("perWeekTxt").textContent = `${n} post${n === 1 ? "" : "s"} a week`;
}
async function saveSchedule(patch, note) {
  try {
    state.settings = await send({ type: "setSchedule", ...patch });
    if (note) toast(note);
    await renderStatusLine();
    state.rhythm = await send({ type: "rhythm" }).catch(() => state.rhythm);
    renderQueue();
  } catch (e) {
    toast(e.message);
    renderSchedule();
  }
}
$("perDay").addEventListener("click", e => {
  const b = e.target.closest("button");
  // your best hours when there's enough data, otherwise sensible defaults
  const bw = b && XLIInsights.bestWindows(xAnalysis(), +b.dataset.n);
  if (b) saveSchedule({ slotTimes: bw ? bw.text : XLISlots.PRESETS[b.dataset.n] }, `${b.dataset.n} a day${bw ? ", at your best hours" : ""}`);
});
$("slotTimes").addEventListener("change", e => saveSchedule({ slotTimes: e.target.value.trim() }, "Posting times saved"));
$("slotNatural").addEventListener("change", e => saveSchedule({ slotNatural: e.target.checked }));
$("runBtn").onclick = async () => {
  await send({ type: "startRun" });
  await renderStatusLine();
  renderRhythm();
  toast("12-week run started. This is week 1.");
};

// ---------- published ----------
function renderPublished() {
  const rows = Object.entries(state.liStatus)
    .filter(([, s]) => s.state === "posted")
    .sort((a, b) => b[1].at - a[1].at);
  $("emptyPublished").hidden = rows.length > 0;
  $("pubRows").innerHTML = rows
    .map(([id, s]) => {
      const p = state.byId.get(id);
      const imgs = (s.images && s.images.length ? s.images : p?.images || []).slice(0, 4);
      const media = s.visual === "none" ? [] : imgs;
      const text = s.text || p?.text || "";
      return `<div class="pub-row">
        <div class="pub-d"><b>${esc(new Date(s.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</b><span>${esc(fmtTime(s.at))}</span></div>
        <div class="pub-main">
          <p>${esc(text)}</p>
          <div class="pub-foot">
            ${s.visual === "card" ? `<span class="tag">${icon("card")}Tweet card</span>` : media.length ? `<span class="tag">${icon("image")}${media.length} image${media.length > 1 ? "s" : ""}</span>` : `<span class="tag">${icon("text")}Text</span>`}
            ${s.url ? `<a href="${esc(s.url)}" target="_blank">View on LinkedIn</a>` : `<span class="tag">Marked manually</span>`}
            ${p ? `<a href="${esc(p.url)}" target="_blank">Original on X</a>` : ""}
          </div>
        </div>
        ${media.length ? `<div class="pub-media n${Math.min(media.length, 2)}">${media.slice(0, 2).map(u => `<img src="${esc(smallImg(u))}" alt="" loading="lazy">`).join("")}</div>` : ""}
      </div>`;
    })
    .join("");
}

// ---------- calendar ----------
const cal = { y: new Date().getFullYear(), m: new Date().getMonth(), mode: "week", week: 0 };
try { const m = localStorage.getItem("calMode"); if (m === "month" || m === "week") cal.mode = m; } catch {}
function renderCalendar() {
  document.querySelectorAll("#calMode button").forEach(b => b.classList.toggle("on", b.dataset.m === cal.mode));
  $("cal").hidden = cal.mode === "week";
  document.querySelector(".cal-legend").hidden = cal.mode === "week";
  $("wkv").hidden = cal.mode !== "week";
  if (cal.mode === "week") return renderWeek();
  const first = new Date(cal.y, cal.m, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // Monday on or before the 1st
  const last = new Date(cal.y, cal.m + 1, 0);
  const end = new Date(last);
  end.setDate(last.getDate() + (7 - ((last.getDay() + 6) % 7)) - 1);
  end.setHours(23, 59, 59, 999);
  $("calTitle").textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const sugg = suggestions(120);
  const dayKey = ts => new Date(ts).toDateString();
  const byDay = new Map();
  const add = (ts, item) => {
    const k = dayKey(ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push({ ...item, at: ts });
  };
  for (const [id, s] of Object.entries(state.liStatus)) if (s.state === "posted" && s.at >= start.getTime() && s.at <= end.getTime()) add(s.at, { kind: "posted", id, text: s.text || state.byId.get(id)?.text || "", url: s.url });
  for (const q of state.queue) if (q.at >= start.getTime() && q.at <= end.getTime()) add(q.at, { kind: q.status === "failed" ? "failed" : "sched", id: q.tweetId, qid: q.qid, text: q.text });
  for (const [t, p] of sugg) if (t >= start.getTime() && t <= end.getTime()) add(t, { kind: "sugg", id: p.id, text: p.text });
  const now = Date.now();
  for (const sl of XLISlots.between(Math.max(start.getTime(), now + 60000), end.getTime() + 1, state.settings)) {
    if (!XLISlots.taken(sl, state.queue) && !sugg.has(sl.at)) add(sl.at, { kind: "open" });
  }

  // month summary
  const inMonth = ts => new Date(ts).getMonth() === cal.m && new Date(ts).getFullYear() === cal.y;
  let c = { posted: 0, sched: 0, sugg: 0, open: 0 };
  for (const [, items] of byDay) for (const it of items) if (inMonth(it.at) && c[it.kind === "failed" ? "sched" : it.kind] !== undefined) c[it.kind === "failed" ? "sched" : it.kind]++;
  $("calSummary").innerHTML = [`<b>${c.posted}</b> posted`, `<b>${c.sched}</b> scheduled`, c.sugg ? `<b>${c.sugg}</b> suggested` : "", c.open ? `<b>${c.open}</b> open` : ""].filter(Boolean).join(`<i class="dotsep"></i>`);

  const target = state.rhythm?.target || 3;
  let html = `<div class="cal-head">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<span>${x}</span>`).join("")}<span class="wk-h">Week</span></div>`;
  const d = new Date(start);
  const todayKey = new Date().toDateString();
  while (d <= end) {
    const wkStart = new Date(d);
    const wkHasItems = [...Array(7)].some((_, i) => {
      const x = new Date(wkStart);
      x.setDate(x.getDate() + i);
      return x.getMonth() === cal.m && (byDay.get(x.toDateString()) || []).length;
    });
    html += `<div class="cal-week ${wkHasItems ? "" : "quiet"}">`;
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const k = d.toDateString();
      const items = (byDay.get(k) || []).sort((a, b) => a.at - b.at);
      weekCount += items.filter(x => x.kind === "posted" || x.kind === "sched").length;
      const cls = ["cal-day", d.getMonth() !== cal.m ? "out" : "", k === todayKey ? "today" : "", items.length ? "" : "noitems", d.getTime() + 864e5 < now ? "past" : ""].join(" ");
      html += `<div class="${cls}" data-day="${d.getTime()}"><div class="cd-n"><span>${d.getDate()}</span><em>${d.toLocaleDateString(undefined, { weekday: "short" })}</em></div>`;
      for (const it of items.slice(0, 4)) {
        const time = fmtTime(it.at).replace(":00", "").replace(" ", "").toLowerCase();
        if (it.kind === "open") html += `<button class="chip open" data-k="open" data-at="${it.at}"><span class="tm">${time}</span><span class="tx">Open slot</span></button>`;
        else html += `<button class="chip ${it.kind}" data-k="${it.kind}" data-id="${esc(it.id)}" data-at="${it.at}"${it.qid ? ` data-qid="${esc(it.qid)}" draggable="true"` : ""} title="${esc(it.text.slice(0, 200))}"><span class="tm">${time}</span><span class="tx">${esc(it.text.replace(/\s+/g, " ").slice(0, 90))}</span>${it.kind === "sugg" ? `<i class="add" data-add="1">+</i>` : ""}</button>`;
      }
      if (items.length > 4) html += `<span class="more-n">+${items.length - 4} more</span>`;
      html += `</div>`;
      d.setDate(d.getDate() + 1);
    }
    const met = weekCount >= target;
    html += `<div class="cal-wk ${met ? "met" : ""}"><b>${weekCount}</b><span>/${target}</span></div></div>`;
  }
  $("cal").innerHTML = html;
  // drag a scheduled post: onto an open slot (takes its time), another post (swap), or a day (same time of day)
  $("cal").querySelectorAll(".chip[data-qid]").forEach(ch =>
    ch.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData("text/xli-qid", ch.dataset.qid);
      ev.dataTransfer.effectAllowed = "move";
      document.body.classList.add("dragging");
    })
  );
  $("cal").querySelectorAll(".chip").forEach(ch => ch.addEventListener("dragend", () => document.body.classList.remove("dragging")));
  $("cal").querySelectorAll(".chip.open, .chip[data-qid]").forEach(ch => dropTarget(ch, () => ({ at: +ch.dataset.at, qid: ch.dataset.qid })));
  $("cal").querySelectorAll(".cal-day").forEach(day =>
    dropTarget(day, () => {
      const qid = dragQid;
      const q = qid && state.queue.find(x => x.qid === qid);
      if (!q) return { at: +day.dataset.day + 12 * 3600e3 };
      const t = new Date(q.at);
      const d = new Date(+day.dataset.day);
      return { at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes()).getTime() };
    })
  );
  $("cal").querySelectorAll(".chip").forEach(ch =>
    ch.addEventListener("click", e => {
      const at = +ch.dataset.at;
      const id = ch.dataset.id;
      if (ch.dataset.k === "sugg" && e.target.dataset.add) return acceptSuggestion(at, id);
      if (ch.dataset.k === "sugg") {
        state.fillAt = at;
        return openComposer(id);
      }
      if (ch.dataset.k === "open") {
        state.fillAt = at;
        state.status = "open";
        return go("library");
      }
      if (ch.dataset.k === "posted") {
        const s = state.liStatus[id];
        if (s?.url) return window.open(s.url, "_blank");
      }
      if (id && state.byId.get(id)) openComposer(id);
    })
  );
}
// ---------- the week board: what's going out, how it did, and how good each slot is ----------
const normT = t => String(t || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
function liStatsByText() { const m = new Map(); for (const p of state.liposts || []) { const k = normT(p.text); if (k) m.set(k, p); } return m; }
function slotScore(a, ts) {
  if (!a.count) return null;
  const d = new Date(ts), c = a.heat[d.getDay()][d.getHours()];
  if (c && c.n >= 2) return c.score;
  const h = a.hourly[d.getHours()];
  return h && h.n >= 3 ? h.score : null;
}
function scoreTag(sc) {
  if (sc == null) return "";
  const cls = sc >= 1.5 ? "hot" : sc >= 0.9 ? "ok" : "cold";
  const word = sc >= 1.5 ? "Great slot" : sc >= 0.9 ? "Good slot" : "Quiet slot";
  return `<span class="wk-slot ${cls}" title="Posts at this hour do ${XLIInsights.times(sc)} your usual on X">${word} · ${XLIInsights.times(sc)}</span>`;
}
function topicKey(t) { const w = normT(t).split(" ").filter(x => x.length > 3 && !/^(this|that|with|from|have|just|your|what|about|been|were|they|them|will|into|more|some)$/.test(x)); return w.slice(0, 2).join(" "); }
function renderWeek() {
  const a = xAnalysis(), I = XLIInsights, now = Date.now();
  const base = new Date(); base.setHours(0, 0, 0, 0); base.setDate(base.getDate() - ((base.getDay() + 6) % 7) + cal.week * 7);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(base); d.setDate(d.getDate() + i); return d; });
  const start = days[0].getTime(), end = days[6].getTime() + 864e5;
  $("calTitle").textContent = cal.week === 0 ? "This week" : cal.week === 1 ? "Next week" : cal.week === -1 ? "Last week" : days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " – " + days[6].toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const li = liStatsByText();
  const M = a.metric === "views" ? p => p.views || 0 : p => (p.likes || 0) + 2 * (p.reposts || 0) + 2 * (p.replies || 0);
  const items = [];
  for (const [id, st] of Object.entries(state.liStatus)) if (st.state === "posted" && st.at >= start && st.at < end) items.push({ kind: "posted", at: st.at, id, text: st.text || state.byId.get(id)?.text || "", url: st.url });
  for (const q of state.queue) if (q.at >= start && q.at < end) items.push({ kind: q.status === "failed" ? "failed" : "sched", at: q.at, id: q.tweetId, qid: q.qid, text: q.text, images: q.images });
  // open slots, each with the post that would fit best: what you haven't reviewed, else what you skipped that did well on X
  const pool = reviewList().slice();
  const strong = [...state.skipped].map(id => state.byId.get(id)).filter(p => p && a.count && M(p) / a.baseline >= 1.5).sort((x, y) => M(y) - M(x));
  for (const sl of XLISlots.between(Math.max(start, now + 60000), end, state.settings)) if (!XLISlots.taken(sl, state.queue)) items.push({ kind: "open", at: sl.at, pick: pool.shift() || strong.shift() || null });
  items.sort((x, y) => x.at - y.at);
  // the week in numbers
  const out = items.filter(x => x.kind === "posted" || x.kind === "sched" || x.kind === "failed");
  const xReach = out.reduce((t, x) => t + M(state.byId.get(x.id) || {}), 0);
  const liReach = out.reduce((t, x) => t + ((li.get(normT(x.text)) || {}).impressions || 0), 0);
  const fits = out.map(x => { const p = state.byId.get(x.id); return p ? fitOf(p).label : "unclear"; });
  const photos = out.filter(x => (x.images && x.images.length) || (state.byId.get(x.id)?.images || []).length).length;
  // same topic three times in a row reads as repetitive on LinkedIn
  let repeat = null; for (let i = 2; i < out.length; i++) { const k = topicKey(out[i].text); if (k && k === topicKey(out[i - 1].text) && k === topicKey(out[i - 2].text)) { repeat = k; break; } }
  const target = state.rhythm?.target || 3;
  const head = `<div class="wk-stats">
      <div><b>${out.length}<em>/${target}</em></b><span>posts this week</span></div>
      <div><b>${fmtN(xReach)}</b><span>${a.metricLabel || "views"} they got on X</span></div>
      <div><b>${liReach ? fmtN(liReach) : "–"}</b><span>LinkedIn impressions so far</span></div>
      <div class="wk-mix"><span class="mix">${["work", "personal", "unclear"].map(k => { const n = fits.filter(f => f === k).length; return n ? `<i class="mx ${k}" style="flex:${n}"></i>` : ""; }).join("")}</span><span>${fits.filter(f => f === "work").length} work · ${fits.filter(f => f === "personal").length} personal · ${photos} with photos</span></div>
    </div>${repeat ? `<p class="wk-warn">Three posts in a row about “${esc(repeat)}”. Swap one for something different so LinkedIn doesn't see the same thing three days running.</p>` : ""}`;
  const col = d => {
    const k = d.toDateString(), mine = items.filter(x => new Date(x.at).toDateString() === k), isToday = k === new Date().toDateString(), past = d.getTime() + 864e5 < now;
    const best = a.count ? I.bestHourOn(a, d.getDay()) : null;
    const strip = a.count ? a.heat[d.getDay()].map((c, h) => `<i style="${c.n ? "background:" + heatColor(c.score) : ""}" title="${I.hourLabel(h)}${c.n ? " · " + I.times(c.score) : ""}"></i>`).join("") : "";
    const card = x => {
      const p = x.kind === "open" ? x.pick : state.byId.get(x.id);
      const img = (x.images && x.images[0]) || (p && p.images && p.images[0]);
      const time = fmtTime(x.at).replace(" ", "").toLowerCase();
      if (x.kind === "open") return `<div class="wk-card open" data-k="open" data-at="${x.at}"><div class="wk-top"><span class="wk-time">${time}</span>${scoreTag(slotScore(a, x.at))}</div>${p ? `<div class="wk-txt">${esc((p.text || "").slice(0, 110))}</div><div class="wk-data">${M(p) ? `<span>${fmtN(M(p))} ${a.metricLabel || "views"} on X</span>` : ""}</div><div class="wk-acts"><button class="btn sm" data-fill="${esc(p.id)}" data-at="${x.at}">Schedule this</button><button class="linkbtn" data-pick="${x.at}">Pick another</button></div>` : `<div class="wk-empty">Open slot</div><div class="wk-acts"><button class="linkbtn" data-pick="${x.at}">Pick a post</button></div>`}</div>`;
      const s = li.get(normT(x.text)), fit = p ? fitOf(p).label : "", xs = p ? M(p) : 0;
      return `<div class="wk-card ${x.kind}" data-k="${x.kind}" data-id="${esc(x.id || "")}" data-at="${x.at}"${x.qid ? ` data-qid="${esc(x.qid)}" draggable="true"` : ""}>
        ${img ? `<div class="wk-img" style="background-image:url('${esc(img)}')"></div>` : ""}
        <div class="wk-top"><span class="wk-time">${time}</span>${x.kind === "posted" ? '<span class="wk-pill ok">Posted</span>' : x.kind === "failed" ? '<span class="wk-pill bad">Failed</span>' : scoreTag(slotScore(a, x.at))}</div>
        <div class="wk-txt">${esc((x.text || "").replace(/\s+/g, " ").slice(0, 140))}</div>
        <div class="wk-data">${xs ? `<span title="How it did on X">${icon("eye")}${fmtN(xs)} on X</span>` : ""}${s ? `<span title="LinkedIn">${icon("like")}${s.likes} · ${fmtN(s.impressions)} on LinkedIn</span>` : ""}${fit === "personal" ? '<span class="wk-tag">Personal</span>' : ""}${p && state.childOf.has(p.id) ? '<span class="wk-tag">Thread</span>' : ""}</div>
      </div>`;
    };
    return `<div class="wk-col${isToday ? " today" : ""}${past ? " past" : ""}" data-day="${d.getTime()}">
      <div class="wk-h"><b>${d.toLocaleDateString(undefined, { weekday: "short" })}</b><span>${d.getDate()}</span>${best != null ? `<em title="Best hour on ${I.DAYS[d.getDay()]}s">best ${I.hourLabel(best)}</em>` : ""}</div>
      ${strip ? `<div class="wk-strip" title="How each hour does on ${I.DAYS[d.getDay()]}s">${strip}</div>` : ""}
      <div class="wk-list">${mine.map(card).join("") || `<div class="wk-none">${past ? "Nothing went out" : "Nothing planned"}</div>`}</div>
    </div>`;
  };
  $("wkv").innerHTML = head + `<div class="wk-grid">${days.map(col).join("")}</div>`;
  XLIIcons.paint($("wkv"));
  const root = $("wkv");
  root.querySelectorAll(".wk-card[data-qid]").forEach(ch => ch.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/xli-qid", ch.dataset.qid); ev.dataTransfer.effectAllowed = "move"; }));
  root.querySelectorAll(".wk-card.open, .wk-card[data-qid]").forEach(ch => dropTarget(ch, () => ({ at: +ch.dataset.at, qid: ch.dataset.qid })));
  root.querySelectorAll(".wk-col").forEach(day => dropTarget(day, () => {
    const q = dragQid && state.queue.find(x => x.qid === dragQid); if (!q) return null;
    const dd = new Date(+day.dataset.day), best = a.count ? I.bestHourOn(a, dd.getDay()) : null;
    // dropped on a day: that day's best hour when we know it, else the same time of day
    const t = new Date(q.at); dd.setHours(best != null ? best : t.getHours(), best != null ? naturalMinute(q.qid) : t.getMinutes(), 0, 0); return { at: dd.getTime() };
  }));
  root.querySelectorAll("[data-fill]").forEach(b => b.onclick = e => { e.stopPropagation(); acceptSuggestion(+b.dataset.at, b.dataset.fill); });
  root.querySelectorAll("[data-pick]").forEach(b => b.onclick = e => { e.stopPropagation(); state.fillAt = +b.dataset.pick; state.status = "open"; go("library"); });
  root.querySelectorAll(".wk-card:not(.open)").forEach(c => c.onclick = () => { const id = c.dataset.id; if (c.dataset.k === "posted") { const s = state.liStatus[id]; if (s?.url) return window.open(s.url, "_blank"); } if (id && state.byId.get(id)) openComposer(id); });
}
$("calPrev").onclick = () => {
  if (cal.mode === "week") { cal.week--; return renderCalendar(); }
  cal.m--;
  if (cal.m < 0) (cal.m = 11), cal.y--;
  renderCalendar();
};
$("calNext").onclick = () => {
  if (cal.mode === "week") { cal.week++; return renderCalendar(); }
  cal.m++;
  if (cal.m > 11) (cal.m = 0), cal.y++;
  renderCalendar();
};
document.querySelectorAll("#calMode button").forEach(b => b.onclick = () => { cal.mode = b.dataset.m; try { localStorage.setItem("calMode", cal.mode); } catch {} renderCalendar(); });
$("calToday").onclick = () => {
  cal.week = 0;
  cal.y = new Date().getFullYear();
  cal.m = new Date().getMonth();
  renderCalendar();
};

// ---------- composer ----------
const cs = { vis: "card", hasImages: false, cardData: null, cardUrl: "", cardKey: "", hasVideo: false, original: "", expanded: false, aiChecked: false };

function openComposer(id) {
  const p = state.byId.get(id);
  if (!p) return;
  state.current = id;
  const thread = threadOf(p);
  const q = queuedFor(id);

  $("cXLink").href = p.url;
  $("cOrigMeta").innerHTML = `<span>${fmtDate(p.createdAt)}</span><span>♥ ${fmtNum(p.likes)}</span>${p.views ? `<span>${fmtNum(p.views)} views</span>` : ""}`;
  $("cThreadWrap").hidden = thread.length < 2;
  $("cThread").checked = true;
  $("cThreadLbl").textContent = `Include the full thread (${thread.length} posts)`;
  $("cMsg").innerHTML = "";

  const fill = () => {
    const parts = $("cThread").checked ? thread : [p];
    $("cOrig").textContent = parts.map(x => x.text).join("\n\n· · ·\n\n");
    cs.original = parts.map(x => x.text).filter(Boolean).join("\n\n");
    $("cText").value = q ? q.text : state.liStatus[id]?.text || cs.original;
    const imgs = parts.flatMap(x => x.images || []).slice(0, 9);
    const chosen = q && q.visual === "images" ? new Set(q.images) : null;
    $("cImgs").innerHTML = imgs
      .map(u => `<label><input type="checkbox" value="${esc(bigImg(u))}" ${!chosen || chosen.has(bigImg(u)) ? "checked" : ""}><img src="${esc(smallImg(u))}" alt=""></label>`)
      .join("");
    cs.hasImages = imgs.length > 0;
    $("cVis").querySelector('[data-v="images"]').lastChild.textContent = imgs.length ? `Post images (${imgs.length})` : "Post images";
    cs.cardData = XLIParse.cardDataFor({ ...p, images: (p.images || []).map(bigImg) });
    cs.hasVideo = parts.some(x => x.hasVideo);
    cs.expanded = false;
    setVis(q && q.visual ? q.visual : XLIParse.visualFor(state.settings.visualMode || "auto", imgs.length > 0));
    resetHook();
    if (parts.some(x => x.truncated)) msg("info", "Long post: only the preview text was saved. Open it on X once to grab the full text, or paste it in.");
    updateCount();
    renderPreview();
  };
  $("cThread").onchange = fill;
  fill();

  $("cAt").value = toLocalInput(state.fillAt || (q ? q.at : Date.now() + 3600_000));
  renderComposerStatus();
  $("scrim").hidden = false;
  $("composer").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("cText").focus(), 50);
}

function renderComposerStatus() {
  const id = state.current;
  if (!id) return;
  const q = queuedFor(id);
  $("cBadge").innerHTML = statusPill(id);
  $("cQueue").lastChild.textContent = q ? "Move to next slot" : "Add to queue";
  $("cUnqueue").hidden = !q;
  $("cSchedule").textContent = state.fillAt ? `Schedule for ${shortWhen(state.fillAt)}` : q ? "Reschedule" : "Schedule";
  $("cSchedBtn").lastChild.textContent = state.fillAt ? shortWhen(state.fillAt) : "Schedule";
  $("cSchedBtn").classList.toggle("primary", !!state.fillAt);
  $("cPost").classList.toggle("primary", !state.fillAt);
  $("cMark").textContent = isPosted(id) ? "Unmark as posted" : "Mark as posted";
  $("cSlotHint").textContent = "";
  if (isPosted(id) && state.liStatus[id].url && !$("cMsg").innerHTML) {
    msg("ok", `Already on LinkedIn. <a href="${esc(state.liStatus[id].url)}" target="_blank">View post</a>. Posting again creates a duplicate.`, true);
  }
}

function closeComposer() {
  state.current = null;
  if (state.view === "review") setTimeout(() => renderReview(true), 0);
  $("composer").hidden = true;
  $("scrim").hidden = true;
  $("schedPop").hidden = true;
  document.body.style.overflow = "";
}

function msg(kind, html, raw) {
  const ic = kind === "ok" ? "check" : kind === "bad" ? "alert" : "alert";
  $("cMsg").innerHTML = html ? `<div class="msg ${kind}">${icon(ic)}<span>${raw ? html : esc(html)}</span></div>` : "";
}

function updateCount() {
  const n = $("cText").value.length;
  $("cCount").textContent = `${n.toLocaleString()} / 3,000`;
  $("cCount").classList.toggle("over", n > 3000);
}

function payload() {
  const text = $("cText").value.trim();
  if (!text) throw new Error("Add some text first.");
  if (text.length > 3000) throw new Error("LinkedIn posts max out at 3,000 characters.");
  const images = cs.vis === "images" ? [...$("cImgs").querySelectorAll("input:checked")].map(i => i.value) : [];
  if (cs.vis === "images" && !images.length) throw new Error("Pick at least one image, or switch the visual.");
  return { tweetId: state.current, text, images, visual: cs.vis, cardData: cs.vis === "card" ? cs.cardData : null };
}

// visual
function setVis(v) {
  if (v === "images" && !cs.hasImages) v = "none";
  cs.vis = v;
  $("cVis").querySelectorAll("button").forEach(b => {
    b.classList.toggle("on", b.dataset.v === v);
    if (b.dataset.v === "images") b.disabled = !cs.hasImages;
  });
  $("cImgs").hidden = v !== "images";
  $("cVideo").hidden = !cs.hasVideo || v === "card";
  $("cVisHint").textContent = v === "card" ? "Screenshot of your post, fills the feed" : v === "images" ? "Your post's own photos" : "Text-only posts get 2 lines in the feed";
  if (v === "card") {
    const key = JSON.stringify(cs.cardData);
    if (key !== cs.cardKey) {
      cs.cardKey = key;
      cs.cardUrl = "";
      send({ type: "renderCard", cardData: cs.cardData })
        .then(r => {
          if (cs.cardKey === key) {
            cs.cardUrl = r.dataUrl;
            renderPreview();
          }
        })
        .catch(e => msg("bad", "Couldn't render the card: " + e.message));
    }
  }
  runLocalChecks();
  renderPreview();
}
$("cVis").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (b && !b.disabled) setVis(b.dataset.v);
});
$("cImgs").addEventListener("change", renderPreview);

// LinkedIn preview
function renderPreview() {
  const name = state.li?.name || state.xProfile.name || "You";
  $("liName").textContent = name;
  setAvatar($("liAv"), state.li?.picture || state.xProfile.avatar, name);

  const text = $("cText").value.trim();
  const box = $("liText");
  // LinkedIn desktop feed: ~3 lines or ~210 characters before "…more"
  const lines = text.split("\n");
  let cut = text.length;
  if (lines.length > 3) cut = lines.slice(0, 3).join("\n").length;
  cut = Math.min(cut, 210);
  if (cs.expanded || text.length <= cut) {
    box.innerHTML = esc(text) || `<span style="color:rgba(0,0,0,.4)">Your post text shows here</span>`;
    $("foldNote").textContent = text.length > cut ? "Expanded view. Readers see the first ~210 characters before “…more”." : "Short enough to show in full.";
  } else {
    let head = text.slice(0, cut);
    const sp = head.lastIndexOf(" ");
    if (sp > cut - 25) head = head.slice(0, sp);
    box.innerHTML = `<span class="fold">${esc(head.trimEnd())}</span>… <span class="more-link" id="liMore">more</span>`;
    $("liMore").onclick = () => ((cs.expanded = true), renderPreview());
    $("foldNote").textContent = "The highlighted part is what people see before they click “…more”. Make it count.";
  }

  const media = $("liMedia");
  if (cs.vis === "card") media.innerHTML = cs.cardUrl ? `<img src="${cs.cardUrl}" alt="">` : `<div class="loading"></div>`;
  else if (cs.vis === "images") {
    const sel = [...$("cImgs").querySelectorAll("input:checked")].map(i => i.value);
    media.innerHTML = !sel.length ? "" : sel.length === 1 ? `<img src="${esc(sel[0])}" alt="">` : `<div class="grid2">${sel.slice(0, 4).map(u => `<img src="${esc(u)}" alt="">`).join("")}</div>`;
  } else media.innerHTML = "";
}

// hook check
function localChecks(text) {
  const lines = text.split("\n").map(l => l.trim());
  const l1 = lines[0] || "";
  const l2 = lines[1] || "";
  return [
    { pass: !!l1 && l1.length <= 70, label: "Line 1 fits the mobile preview", note: l1 ? `${l1.length}/70 characters` : "no first line yet" },
    { pass: !!l1 && !!l2 && (lines.length < 3 || lines[2] === ""), label: "Two-line hook, then a blank line", note: !l2 ? "add a line 2 that gives a second reason to read" : lines[2] ? "add a blank line after line 2" : "" },
    { pass: /\b(I|I'm|I've|I'd|we|we've|my|our|me)\b/i.test(l1) || /\d/.test(l1), label: "Line 1 is lived or has proof", note: "something you did, or a result" },
    { pass: /\d/.test(text) && /\b(for|with)\s+(a|an|my|our|\d)/i.test(text), label: "Specific: who it was for and the outcome", note: "a number and who it was for" },
    { pass: !/—/.test(text), label: "No em dashes", note: "" }
  ];
}
function renderChecks(items, summary) {
  const ok = items.filter(c => c.pass).length;
  $("cHookScore").textContent = `${ok} of ${items.length}`;
  $("cHookScore").className = "score" + (ok === items.length ? " good" : "");
  $("cChecks").innerHTML =
    (summary ? `<li class="sum">${esc(summary)}</li>` : "") +
    items
      .map(c => `<li class="${c.pass ? "pass" : "fail"}"><span class="ic">${icon(c.pass ? "check" : "alert")}</span><span>${esc(c.label)}${c.note && !c.pass ? ` <span class="n">· ${esc(c.note)}</span>` : c.note && c.pass && /\/70/.test(c.note) ? ` <span class="n">· ${esc(c.note)}</span>` : ""}</span></li>`)
      .join("");
}
function resetHook() {
  cs.aiChecked = false;
  $("cOpeners").innerHTML = "";
  runLocalChecks();
}
function runLocalChecks() {
  if (!cs.aiChecked) renderChecks(localChecks($("cText").value));
}
function replaceHook(opener) {
  const lines = $("cText").value.split("\n");
  let i = 0;
  let taken = 0;
  while (i < lines.length && taken < 2) {
    if (lines[i].trim()) taken++;
    i++;
  }
  if (lines[i] !== undefined && !lines[i].trim()) i++;
  $("cText").value = opener.trim() + "\n\n" + lines.slice(i).join("\n").trim();
  onTextChange();
}
function onTextChange() {
  updateCount();
  cs.aiChecked = false;
  clearTimeout(onTextChange.t);
  onTextChange.t = setTimeout(runLocalChecks, 200);
  renderPreview();
}
$("cText").addEventListener("input", onTextChange);

async function busy(btn, label, fn) {
  const lbl = btn.lastChild;
  const old = lbl.textContent;
  btn.disabled = true;
  lbl.textContent = label;
  try {
    await fn();
  } catch (e) {
    msg("bad", e.message);
  } finally {
    btn.disabled = false;
    lbl.textContent = old;
  }
}

$("cHookAI").onclick = e => {
  e.preventDefault();
  e.stopPropagation();
  $("cHookWrap").open = true;
  return hookAI(e);
};
const hookAI = e =>
  busy(e.currentTarget, "Checking…", async () => {
    const text = $("cText").value.trim();
    if (!text) throw new Error("Add some text first.");
    if (!state.settings.anthropicKey) throw new Error("Add an Anthropic API key in Settings to use Claude checks.");
    const r = await send({ type: "hookCheck", text });
    const c = r.checks || {};
    const loc = localChecks(text);
    cs.aiChecked = true;
    renderChecks(
      [
        { pass: !!c.lived_or_proof?.pass, label: "Line 1 is lived or has proof", note: c.lived_or_proof?.note },
        { pass: !!c.specific?.pass, label: "Specific: who it was for and the outcome", note: c.specific?.note },
        { pass: !!c.hook?.pass, label: "First two lines hook", note: c.hook?.note },
        { pass: !!c.chatgpt?.pass, label: "Passes the ChatGPT test", note: c.chatgpt?.note },
        loc[4]
      ],
      r.summary
    );
    $("cOpeners").innerHTML = (r.openers || []).length ? `<div class="op-h">Try a different opener</div>` : "";
    for (const o of r.openers || []) {
      const el = document.createElement("div");
      el.className = "opener";
      el.innerHTML = `<span>${esc(o)}</span><em>Use</em>`;
      el.onclick = () => replaceHook(o);
      $("cOpeners").appendChild(el);
    }
    msg();
  });

$("cRewrite").onclick = e =>
  busy(e.currentTarget, "Rewriting…", async () => {
    if (!state.settings.anthropicKey) throw new Error("Add an Anthropic API key in Settings to use rewrite.");
    const r = await send({ type: "rewrite", text: $("cText").value.trim() || cs.original });
    $("cText").value = r.text;
    onTextChange();
    msg();
  });
$("cReset").onclick = () => {
  $("cText").value = cs.original;
  onTextChange();
};

$("cPost").onclick = e =>
  busy(e.currentTarget, "Posting…", async () => {
    const r = await send({ type: "postNow", ...payload() });
    state.fillAt = null;
    await load();
    const what = r.imageCount ? (r.visual === "card" ? " with the tweet card" : ` with ${r.imageCount} image${r.imageCount > 1 ? "s" : ""}`) : " (text only)";
    msg("ok", `Posted to LinkedIn${what}. <a href="${esc(r.url)}" target="_blank">View post</a>`, true);
  });
$("cQueue").onclick = e =>
  busy(e.currentTarget, "Adding…", async () => {
    const q = queuedFor(state.current);
    if (q) {
      // already queued: keep your edits, move it to the next open slot after its current one
      const { tweetId, ...patch } = payload();
      await send({ type: "updateQueueItem", qid: q.qid, patch });
      const r = await send({ type: "bumpQueueItem", qid: q.qid });
      await load();
      return msg("ok", `Moved to ${esc(shortWhen(r.at))}.`, true);
    }
    const r = await send({ type: "enqueue", items: [payload()] });
    await load();
    msg("ok", `Queued for ${esc(shortWhen(r.added[0].at))}.`, true);
  });
$("cUnqueue").onclick = async () => {
  const q = queuedFor(state.current);
  if (!q) return;
  await unqueue(q);
  renderComposerStatus();
  msg();
};
$("cSchedBtn").onclick = e => {
  e.stopPropagation();
  if (state.fillAt) return $("cSchedule").click();
  $("schedPop").hidden = !$("schedPop").hidden;
};
$("schedPop").addEventListener("click", e => e.stopPropagation());
$("cSchedule").onclick = e =>
  busy(e.currentTarget, "Scheduling…", async () => {
    const at = state.fillAt || new Date($("cAt").value).getTime();
    if (!at || at < Date.now() + 30_000) throw new Error("Pick a time in the future.");
    await send({ type: "enqueue", items: [{ ...payload(), at }] });
    const wasFill = !!state.fillAt;
    state.fillAt = null;
    $("schedPop").hidden = true;
    await load();
    if (wasFill) {
      closeComposer();
      go("queue");
      toast(`Scheduled for ${shortWhen(at)}`);
    } else msg("ok", `Scheduled for ${esc(shortWhen(at))}.`, true);
  });
$("cMark").onclick = async () => {
  await send({ type: "markPosted", tweetId: state.current, posted: !isPosted(state.current) });
  msg();
  await load();
};
$("cClose").onclick = closeComposer;
$("scrim").onclick = closeComposer;
document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  const composerOpen = !$("composer").hidden;
  const overlay = composerOpen || !$("cmd").hidden || !$("sheet").hidden;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return $("cmd").hidden ? openCmd() : closeCmd();
  }
  if (e.key === "Escape") {
    if (!$("cmd").hidden) return closeCmd();
    if (composerOpen) return closeComposer();
    if (!$("sheet").hidden) return closeSettings();
  }
  if (composerOpen && (e.metaKey || e.ctrlKey) && e.key === "Enter") return $("cPost").click();
  if (typing || overlay || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    return openCmd();
  }
  if (state.view === "review") {
    const k = e.key.toLowerCase();
    if (k === "q" || e.key === "Enter") (e.preventDefault(), reviewQueue());
    else if (k === "s") reviewSkip();
    else if (k === "p") reviewPersonal();
    else if (k === "e") state.rCurrent && openComposer(state.rCurrent);
    else if (e.key === "ArrowRight" || k === "j") reviewMove(1);
    else if (e.key === "ArrowLeft" || k === "k") reviewMove(-1);
  }
  if (e.key === "1") go("review");
  if (e.key === "2") go("queue");
  if (e.key === "3") go("calendar");
  if (e.key === "4") go("published");
  if (e.key === "5") go("insights");
});

// live refresh when the background changes things
let reloadT;
chrome.storage.onChanged.addListener(ch => {
  if (ch.xposts || ch.queue || ch.liStatus || ch.auth || ch.history || ch.runStart || ch.xProfile || ch.clientId || ch.slotDays || ch.slotTimes || ch.slotNatural || ch.visualMode) {
    clearTimeout(reloadT);
    reloadT = setTimeout(load, 400);
  }
});

XLIIcons.paint();
const initial = location.hash.slice(1);
if (VIEWS.includes(initial)) state.view = initial;
load();

// fade the bottom of long posts so it's clear there's more to read
function markScroll() {
  const t = document.getElementById("rvText");
  if (!t) return;
  const scrolls = t.scrollHeight > t.clientHeight + 4;
  t.classList.toggle("scrolls", scrolls);
  t.classList.toggle("at-end", scrolls && t.scrollTop + t.clientHeight >= t.scrollHeight - 6);
}
document.addEventListener("DOMContentLoaded", () => {
  const t = document.getElementById("rvText");
  if (t) t.addEventListener("scroll", markScroll, { passive: true });
  window.addEventListener("resize", markScroll);
});

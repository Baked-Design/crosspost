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
function shortWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const tmr = new Date(Date.now() + 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const day = same(d, today) ? "Today" : same(d, tmr) ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${fmtTime(ts)}`;
}

// ---------- data ----------
async function load() {
  const d = await send({ type: "getDashboard" });
  Object.assign(state, {
    posts: d.posts,
    liStatus: d.liStatus,
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

// ---------- shell ----------
const VIEWS = ["review", "queue", "calendar", "published", "library"];
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

function slotLabel(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString();
  const tmr = new Date(Date.now() + 864e5).toDateString();
  const day = d.toDateString() === today ? "today" : d.toDateString() === tmr ? "tomorrow" : d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${fmtTime(ts).replace(":00", "").replace(" ", "").toLowerCase()}`;
}
function nextSlotAt() {
  const taken = new Set(state.queue.map(q => Math.floor(q.at / 60000)));
  return upcomingSlots(60).find(t => !taken.has(Math.floor(t / 60000)));
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
      ? state.skipped.size
        ? `Everything's queued or posted. You skipped ${state.skipped.size}. Press ⌘K to bring them back.`
        : "Everything's queued or posted. New posts from X show up here as you browse."
      : "Crosspost reads your profile once and saves your posts here. Then you review them one at a time.";
    $("importX").hidden = hasPosts;
    $("importArchiveBtn").hidden = hasPosts;
    return;
  }
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
  $("rvQueueLbl").textContent = at ? `Queue for ${slotLabel(at)}` : "Queue";
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
  try {
    await flyOut("u");
    const r = await send({ type: "enqueue", items: [itemFor(id)] });
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

function itemFor(id) {
  const p = state.byId.get(id);
  const parts = threadOf(p);
  const imgs = parts.flatMap(x => x.images || []).slice(0, 9).map(bigImg);
  const visual = XLIParse.visualFor(state.settings.visualMode || "auto", imgs.length > 0);
  return {
    tweetId: id,
    text: parts.map(x => x.text).filter(Boolean).join("\n\n").slice(0, 3000),
    images: visual === "images" ? imgs : [],
    visual,
    cardData: visual === "card" ? XLIParse.cardDataFor({ ...p, images: (p.images || []).map(bigImg) }) : null
  };
}

async function quickQueue(ids) {
  try {
    const order = filteredPosts().list.map(p => p.id).filter(id => ids.includes(id));
    const r = await send({ type: "enqueue", items: (order.length ? order : ids).map(itemFor) });
    state.selected.clear();
    await load();
    toast(r.added.length > 1 ? `Queued ${r.added.length}. First goes out ${shortWhen(r.added[0].at)}` : `Queued for ${shortWhen(r.added[0].at)}`);
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

// import
async function startImport() {
  const r = await send({ type: "startImport" });
  if (r.needsHandle) toast("Open x.com once so we can find your profile, then import again");
}
$("importX").onclick = startImport;
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
function parseTimes(str) {
  return String(str || "09:00")
    .split(/[,\s]+/)
    .map(t => t.match(/^(\d{1,2}):(\d{2})$/))
    .filter(Boolean)
    .map(m => [+m[1], +m[2]])
    .filter(([h, m]) => h < 24 && m < 60)
    .sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
}

function upcomingSlots(days = 14) {
  const times = parseTimes(state.settings.slotTimes);
  const dset = new Set((state.settings.slotDays || []).map(Number));
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    if (dset.has(d.getDay())) for (const [h, m] of times) {
      const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      if (ts > Date.now() + 60_000) out.push(ts);
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function slotsBetween(a, b) {
  const times = parseTimes(state.settings.slotTimes);
  const dset = new Set((state.settings.slotDays || []).map(Number));
  const out = [];
  const d = new Date(a);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() < b) {
    if (dset.has(d.getDay())) for (const [h, m] of times) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Map each upcoming open slot to a suggested imported-but-unposted post (best first, no repeats).
function suggestions(days = 70) {
  const taken = new Set(state.queue.map(q => Math.floor(q.at / 60000)));
  const open = upcomingSlots(days).filter(t => !taken.has(Math.floor(t / 60000)));
  const pool = reviewList();
  const map = new Map();
  open.forEach((t, i) => pool[i] && map.set(t, pool[i]));
  return map;
}

async function acceptSuggestion(at, id) {
  try {
    const it = itemFor(id);
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

  const minute = t => Math.floor(t / 60000);
  const items = [...state.queue].sort((a, b) => a.at - b.at);
  const taken = new Set(items.map(q => minute(q.at)));
  const entries = [...items.map(q => ({ at: q.at, q })), ...upcomingSlots().filter(t => !taken.has(minute(t))).map(t => ({ at: t, empty: true }))].sort(
    (a, b) => a.at - b.at
  );

  const list = $("queueList");
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="calm" style="padding-top:12vh"><h2>Nothing scheduled</h2><p>Open Schedule to pick posting days, then queue posts from Review.</p></div>`;
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
    row.innerHTML = `<div class="slot-t">${fmtTime(e.at)}</div>`;
    row.appendChild(e.empty ? emptySlot(e.at) : queueCard(e.q));
    list.appendChild(row);
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
      <button class="btn sm ghost" data-a="now">${icon("send")}Post now</button>
      <button class="icon-btn danger" data-a="rm" title="Remove from queue">${icon("trash")}</button>
    </div>`;
  if (q.visual === "card" && q.cardData) {
    send({ type: "renderCard", cardData: q.cardData }).then(r => (el.querySelector("[data-card]").src = r.dataUrl)).catch(() => {});
  }
  el.querySelector('[data-a="rm"]').onclick = async () => {
    await send({ type: "removeQueueItem", qid: q.qid });
    toast("Removed from queue");
    load();
  };
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

function renderRhythm() {
  const r = state.rhythm;
  if (!r) return;
  const short = d => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("ppw").value = String(r.target);
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
  if (document.activeElement !== $("slotTimes")) $("slotTimes").value = s.slotTimes || "09:00";
  const days = new Set((s.slotDays || []).map(Number));
  $("slotDays").innerHTML = "";
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const b = document.createElement("div");
    b.className = "day" + (days.has(d) ? " on" : "");
    b.textContent = DAY[d].slice(0, 2);
    b.title = DAY[d];
    b.onclick = async () => {
      days.has(d) ? days.delete(d) : days.add(d);
      state.settings.slotDays = [...days];
      await chrome.storage.local.set({ slotDays: [...days] });
      renderQueue();
    };
    $("slotDays").appendChild(b);
  }
}
$("slotTimes").addEventListener("change", async e => {
  const v = e.target.value.trim();
  if (!/^\s*\d{1,2}:\d{2}(\s*,\s*\d{1,2}:\d{2})*\s*$/.test(v)) return toast("Use 24h times like 09:00, 17:30");
  state.settings.slotTimes = v;
  await chrome.storage.local.set({ slotTimes: v });
  toast("Posting times saved");
  renderQueue();
});
$("ppw").addEventListener("change", async e => {
  await chrome.storage.local.set({ postsPerWeek: +e.target.value });
  state.settings.postsPerWeek = +e.target.value;
  await renderStatusLine();
  renderRhythm();
});
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
const cal = { y: new Date().getFullYear(), m: new Date().getMonth() };
function renderCalendar() {
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
  for (const q of state.queue) if (q.at >= start.getTime() && q.at <= end.getTime()) add(q.at, { kind: q.status === "failed" ? "failed" : "sched", id: q.tweetId, text: q.text });
  for (const [t, p] of sugg) if (t >= start.getTime() && t <= end.getTime()) add(t, { kind: "sugg", id: p.id, text: p.text });
  const now = Date.now();
  const taken = new Set(state.queue.map(q => Math.floor(q.at / 60000)));
  for (const t of slotsBetween(Math.max(start.getTime(), now), end.getTime() + 1)) {
    if (t > now + 60000 && !taken.has(Math.floor(t / 60000)) && !sugg.has(t)) add(t, { kind: "open" });
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
      html += `<div class="${cls}"><div class="cd-n"><span>${d.getDate()}</span><em>${d.toLocaleDateString(undefined, { weekday: "short" })}</em></div>`;
      for (const it of items.slice(0, 3)) {
        const time = fmtTime(it.at).replace(":00", "").replace(" ", "").toLowerCase();
        if (it.kind === "open") html += `<button class="chip open" data-k="open" data-at="${it.at}"><span class="tm">${time}</span><span class="tx">Open slot</span></button>`;
        else html += `<button class="chip ${it.kind}" data-k="${it.kind}" data-id="${esc(it.id)}" data-at="${it.at}" title="${esc(it.text.slice(0, 200))}"><span class="tm">${time}</span><span class="tx">${esc(it.text.replace(/\s+/g, " ").slice(0, 90))}</span>${it.kind === "sugg" ? `<i class="add" data-add="1">+</i>` : ""}</button>`;
      }
      if (items.length > 3) html += `<span class="more-n">+${items.length - 3} more</span>`;
      html += `</div>`;
      d.setDate(d.getDate() + 1);
    }
    const met = weekCount >= target;
    html += `<div class="cal-wk ${met ? "met" : ""}"><b>${weekCount}</b><span>/${target}</span></div></div>`;
  }
  $("cal").innerHTML = html;
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
$("calPrev").onclick = () => {
  cal.m--;
  if (cal.m < 0) (cal.m = 11), cal.y--;
  renderCalendar();
};
$("calNext").onclick = () => {
  cal.m++;
  if (cal.m > 11) (cal.m = 0), cal.y++;
  renderCalendar();
};
$("calToday").onclick = () => {
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
    const r = await send({ type: "enqueue", items: [payload()] });
    await load();
    msg("ok", `Queued for ${esc(fmtWhen(r.added[0].at))}.`, true);
  });
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
    } else msg("ok", `Scheduled for ${esc(fmtWhen(at))}.`, true);
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
});

// live refresh when the background changes things
let reloadT;
chrome.storage.onChanged.addListener(ch => {
  if (ch.xposts || ch.queue || ch.liStatus || ch.auth || ch.history || ch.runStart || ch.xProfile || ch.clientId || ch.slotDays || ch.slotTimes || ch.visualMode) {
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

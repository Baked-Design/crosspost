// What worked: reach, best times and the kind of posts that land, from the posts Crosspost already knows.
// Pure functions (no storage, no network), shared by the dashboard and the tests.
(() => {
  const DAY = 864e5;
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const STOP = new Set(("the a an and or but if then so to of in on at for with from by is are was were be been it its this that these those i you we they he she my your our their me us them just " +
    "not no yes do does did have has had will would can could should about into over out up down more most very really what when where why how all any some one two new get got make made like " +
    "than too also only even still here there now today via amp https http com www it's i'm don't you're we're").split(" "));

  // one shape for X and LinkedIn posts
  function prep(p) {
    const text = String(p.text || "");
    const eng = (p.likes || 0) + 2 * (p.reposts || 0) + 2 * (p.replies || p.comments || 0);
    return { ...p, text, eng, views: p.views || p.impressions || 0 };
  }
  // what a post "is": each is a yes/no we can compare
  const FEATURES = [
    ["image", "Has a photo", p => (p.images || []).length > 0 || !!p.hasImage],
    ["video", "Has a video", p => !!p.hasVideo],
    ["thread", "Thread (more than one post)", p => !!p.isThread],
    ["short", "Short (under 100 characters)", p => p.text.replace(/https?:\/\/\S+/g, "").trim().length < 100],
    ["long", "Long (over 280 characters)", p => p.text.length > 280],
    ["numbers", "Has numbers ($, %, results)", p => /(\d+%|\$\s?\d|\d+x\b|\b\d{2,}\b)/i.test(p.text)],
    ["question", "Asks a question", p => /\?\s*$/.test(p.text.trim())],
    ["list", "A list or steps", p => (p.text.match(/^\s*([-•→*]|\d+[.)])\s/gm) || []).length >= 2],
    ["link", "Has a link", p => /https?:\/\//.test(p.text)],
    ["story", "Personal story (I…)", p => /^(i|i'm|i've|my)\b/i.test(p.text.trim())],
    ["work", "About work (design, clients, building)", p => p.fit === "work"],
    ["personal", "Personal life", p => p.fit === "personal"],
  ];

  // metric: views when X gave us views for most posts, otherwise likes + reposts + replies
  function metricOf(list) {
    const withViews = list.filter(p => p.views > 0).length;
    return withViews >= Math.max(3, list.length * 0.5) ? { key: "views", label: "views", get: p => p.views } : { key: "eng", label: "engagement", get: p => p.eng };
  }

  function analyze(raw, { now = Date.now(), days = 365 } = {}) {
    const list = raw.map(prep).filter(p => p.createdAt && p.createdAt > now - days * DAY && p.createdAt <= now);
    const out = { count: list.length, metric: null, baseline: 0, heat: [], slots: [], reach: null, features: [], topics: [], top: [], flops: [], hourly: [], daily: [] };
    if (!list.length) return out;
    const M = metricOf(list);
    out.metric = M.key; out.metricLabel = M.label;
    // newer posts haven't finished getting views: judge posts at least a day old
    const settled = list.filter(p => p.createdAt < now - DAY);
    const base = median((settled.length >= 5 ? settled : list).map(M.get)) || 1;
    out.baseline = base;
    for (const p of list) p.rel = M.get(p) / base;
    const judged = settled.length >= 5 ? settled : list;

    // heat map: 7 days x 24 hours, in your time zone. Each cell: posts, and how they did vs your usual
    const cell = () => ({ n: 0, rels: [], ids: [] });
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, cell));
    for (const p of judged) { const d = new Date(p.createdAt), c = grid[d.getDay()][d.getHours()]; c.n++; c.rels.push(p.rel); c.ids.push(p.id); }
    out.heat = grid.map(row => row.map(c => ({ n: c.n, score: c.n ? median(c.rels) : null, ids: c.ids })));
    out.hourly = Array.from({ length: 24 }, (_, h) => { const r = grid.flatMap(row => row[h].rels); return { h, n: r.length, score: r.length ? median(r) : null }; });
    out.daily = grid.map((row, d) => { const r = row.flatMap(c => c.rels); return { d, n: r.length, score: r.length ? median(r) : null }; });
    // best times: 2-hour windows with at least 2 posts, best median first
    const slots = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      if (!grid[d][h].n) continue;   // a window starts at an hour you actually posted
      const r = [...grid[d][h].rels, ...grid[d][(h + 1) % 24].rels];
      if (r.length >= 2) slots.push({ d, h, n: r.length, score: median(r) });
    }
    slots.sort((a, b) => b.score - a.score || b.n - a.n);
    const picked = [];
    for (const s of slots) { if (picked.some(x => x.d === s.d && Math.abs(x.h - s.h) < 2)) continue; picked.push(s); if (picked.length >= 3) break; }
    out.slots = picked;
    // any day: best hours across the week
    const hours = [];
    for (let h = 0; h < 24; h++) { if (!out.hourly[h].n) continue; const r = [...grid.flatMap(row => row[h].rels), ...grid.flatMap(row => row[(h + 1) % 24].rels)]; if (r.length >= 3) hours.push({ h, n: r.length, score: median(r) }); }
    hours.sort((a, b) => b.score - a.score);
    out.bestHours = hours.slice(0, 2);

    // reach: the last 30 days vs the 60 before, and how many beat your usual
    const recent = judged.filter(p => p.createdAt > now - 31 * DAY), before = judged.filter(p => p.createdAt <= now - 31 * DAY && p.createdAt > now - 91 * DAY);
    const mr = median(recent.map(M.get)), mb = median(before.map(M.get));
    out.reach = { recent: recent.length, median: mr, before: mb, trend: mb && recent.length >= 3 && before.length >= 3 ? Math.round((mr - mb) / mb * 100) : null,
      beat: recent.length ? Math.round(recent.filter(p => p.rel >= 1).length / recent.length * 100) : null, total: list.reduce((t, p) => t + M.get(p), 0) };

    // what kind of post works: median result with vs without each feature (both sides need 3+ posts)
    for (const [key, label, test] of FEATURES) {
      const yes = judged.filter(test), no = judged.filter(p => !test(p));
      if (yes.length < 3 || no.length < 3) continue;
      const a = median(yes.map(p => p.rel)), b = median(no.map(p => p.rel)) || 0.01;
      out.features.push({ key, label, n: yes.length, lift: a / b });
    }
    out.features.sort((x, y) => y.lift - x.lift);

    // topics: words and pairs that show up in 3+ posts, ranked by how those posts did
    const seen = new Map();
    for (const p of judged) {
      const words = p.text.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{L}\p{N}$#@' ]+/gu, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w) && !w.startsWith("@"));
      const grams = new Set(words);
      for (let i = 0; i < words.length - 1; i++) grams.add(words[i] + " " + words[i + 1]);
      for (const g of grams) { const e = seen.get(g) || { t: g, rels: [] }; e.rels.push(p.rel); seen.set(g, e); }
    }
    out.topics = [...seen.values()].filter(e => e.rels.length >= 3).map(e => ({ t: e.t, n: e.rels.length, lift: median(e.rels) }))
      .sort((a, b) => b.lift - a.lift || b.n - a.n).filter((e, i, a) => !a.slice(0, i).some(x => x.t.includes(e.t) || e.t.includes(x.t))).slice(0, 8);

    const ranked = judged.slice().sort((a, b) => b.rel - a.rel);
    out.top = ranked.slice(0, 6).map(p => ({ id: p.id, text: p.text, rel: p.rel, value: M.get(p), createdAt: p.createdAt, url: p.url }));
    out.flops = ranked.slice(-3).reverse().filter(p => p.rel < 0.6).map(p => ({ id: p.id, text: p.text, rel: p.rel, value: M.get(p), createdAt: p.createdAt, url: p.url }));
    return out;
  }

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hourLabel = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");
  const times = x => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + "×";

  // plain-English "post this, then" from the numbers
  function suggest(a, { notOnLinkedIn = [] } = {}) {
    const s = [];
    if (!a || !a.count) return s;
    if (a.slots.length) s.push({ kind: "time", text: `Post around ${a.slots.slice(0, 2).map(x => `${DAYS[x.d]} ${hourLabel(x.h)}`).join(" or ")}. Those slots do ${times(a.slots[0].score)} your usual.` });
    else if (a.bestHours && a.bestHours.length) s.push({ kind: "time", text: `Your best hour is around ${hourLabel(a.bestHours[0].h)}.` });
    const good = a.features.filter(f => f.lift >= 1.25).slice(0, 2), bad = a.features.filter(f => f.lift <= 0.75).slice(-1);
    for (const f of good) s.push({ kind: "format", text: `${f.label}: ${times(f.lift)} the ${a.metricLabel} of posts without it.` });
    for (const f of bad) s.push({ kind: "format", text: `${f.label} tends to do worse (${times(f.lift)}). Use it less.` });
    const topics = a.topics.filter(t => t.lift >= 1.3).slice(0, 3);
    if (topics.length) s.push({ kind: "topic", text: `Topics that land: ${topics.map(t => `“${t.t}”`).join(", ")}. Write more about these.` });
    const redo = a.top.filter(p => notOnLinkedIn.includes(p.id)).slice(0, 3);
    if (redo.length) s.push({ kind: "repost", text: `${redo.length} of your best X posts ${redo.length === 1 ? "isn't" : "aren't"} on LinkedIn yet. Queue ${redo.length === 1 ? "it" : "them"}.`, ids: redo.map(p => p.id) });
    if (a.reach && a.reach.trend != null) s.push({ kind: "reach", text: a.reach.trend >= 0 ? `Reach is up ${a.reach.trend}% on the last 2 months. Keep the rhythm.` : `Reach is down ${Math.abs(a.reach.trend)}% on the last 2 months. Try your best time slots and formats above.` });
    return s;
  }

  globalThis.XLIInsights = { analyze, suggest, median, DAYS, hourLabel, times, FEATURES };
})();

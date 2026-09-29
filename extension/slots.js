// Posting slots, shared by the background worker and the dashboard.
// A schedule is days + time windows. "09:00-11:00" posts once inside that window,
// at a natural-looking minute (9:17, not 9:00). "21:05" posts at exactly 9:05pm.
(function (root) {
  // posts a day -> the windows we start people with (they can edit them)
  const PRESETS = {
    1: "09:00-11:00",
    2: "09:00-11:00, 20:00-23:00",
    3: "09:00-11:00, 12:00-14:00, 20:00-23:00",
    4: "08:00-10:00, 11:00-13:00, 17:00-19:00, 20:00-23:00"
  };
  const DEFAULT_TIMES = PRESETS[1];
  const DEFAULT_DAYS = [1, 2, 3, 4, 5];

  const toMin = (h, m) => h * 60 + m;
  // "09:00-11:00, 20:00, 8:30pm" -> [{s, e}] in minutes after midnight, sorted, no overlaps
  function parse(str) {
    const t = x => {
      const m = String(x).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
      if (!m) return null;
      let h = +m[1];
      const mi = +(m[2] || 0);
      if (m[3] === "pm" && h < 12) h += 12;
      if (m[3] === "am" && h === 12) h = 0;
      return h < 24 && mi < 60 ? toMin(h, mi) : null;
    };
    const out = [];
    for (const part of String(str || "").split(",")) {
      if (!part.trim()) continue;
      const [a, b] = part.split(/\s*[-–to]+\s*(?=\d)/);
      const s = t(a);
      const e = b === undefined ? s : t(b);
      if (s == null || e == null || e < s) return null; // bad input: caller shows a hint
      out.push({ s, e });
    }
    out.sort((x, y) => x.s - y.s);
    for (let i = 1; i < out.length; i++) if (out[i].s <= out[i - 1].e) return null;
    return out;
  }
  const valid = str => { const w = parse(str); return !!(w && w.length); };
  const windows = s => parse(s.slotTimes) || parse(DEFAULT_TIMES);
  const days = s => new Set((s.slotDays && s.slotDays.length ? s.slotDays : DEFAULT_DAYS).map(Number));

  // small stable hash, so a day's slot time stays put every time we compute it
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  }
  function minuteFor(d, i, w, s) {
    if (w.e === w.s) return w.s;
    if (s.slotNatural === false) return w.s;
    const lo = w.e - w.s > 12 ? w.s + 4 : w.s; // not right on the hour
    const hi = w.e - w.s > 12 ? w.e - 4 : w.e;
    let m = lo + Math.floor(hash(`${s.slotSeed || ""}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${i}`) * (hi - lo));
    if (m % 5 === 0 && m + 2 <= hi) m += 2; // skip the round-number look
    return m;
  }

  // every slot from a to b (ms). Each: {at, dayStart, w: window index, s, e}
  function between(a, b, s) {
    const ws = windows(s);
    const ds = days(s);
    const out = [];
    const d = new Date(a);
    d.setHours(0, 0, 0, 0);
    for (let guard = 0; d.getTime() < b && guard < 800; guard++) {
      if (ds.has(d.getDay())) {
        ws.forEach((w, i) => {
          const m = minuteFor(d, i, w, s);
          const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(m / 60), m % 60).getTime();
          if (at >= a && at < b) out.push({ at, dayStart: d.getTime(), w: i, s: w.s, e: w.e });
        });
      }
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  // Is this slot already used by something in the queue? A post anywhere inside the
  // window counts (so dragging 9:17 to 10:40 keeps the morning slot filled).
  function taken(slot, queue) {
    const pad = slot.e === slot.s ? 30 : 5;
    const a = slot.dayStart + (slot.s - pad) * 60000;
    const b = slot.dayStart + (slot.e + pad) * 60000;
    return queue.some(q => q.at >= a && q.at <= b);
  }

  function upcoming(s, queue, count, from = Date.now() + 60000) {
    const out = [];
    for (let k = 0; k < 24 && out.length < count; k++) {
      const a = from + k * 30 * 864e5;
      for (const sl of between(a, a + 30 * 864e5, s)) {
        if (!taken(sl, queue)) out.push(sl);
        if (out.length >= count) break;
      }
    }
    return out;
  }

  // "Today 9:17pm", "Tomorrow 9:12am", "Sun, Oct 4 · 9:17am" (plus the year if it's not this one)
  function label(ts) {
    const d = new Date(ts);
    const now = new Date();
    const dayDiff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Tomorrow ${time}`;
    const opts = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return `${d.toLocaleDateString(undefined, opts)} · ${time}`;
  }

  const perWeek = s => windows(s).length * days(s).size;

  root.XLISlots = { PRESETS, DEFAULT_TIMES, DEFAULT_DAYS, parse, valid, between, taken, upcoming, label, perWeek };
})(typeof self !== "undefined" ? self : this);

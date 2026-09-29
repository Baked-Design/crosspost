// Adds a small LinkedIn button to the action bar of every one of YOUR posts on x.com.
// Click it to open the preview and post it (or queue it) on LinkedIn.
(() => {
  if (window.__xliButtons) return;
  window.__xliButtons = true;

  const send = msg =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          res && res.ok ? resolve(res.data) : reject(new Error(res ? res.error : "No response"));
        });
      } catch (e) {
        reject(e);
      }
    });

  const bigImg = u => (u.includes("name=") ? u.replace(/name=\w+/, "name=large") : u + (u.includes("?") ? "&" : "?") + "name=large");

  let handle = null;
  try {
    chrome.storage.local.get("myHandle", r => r && r.myHandle && (handle = r.myHandle.toLowerCase()));
  } catch {}
  const getHandle = () => (window.XLIHarvest && XLIHarvest.handle()) || handle;

  const ICON_IN = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>`;
  const ICON_OK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;
  const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7z"/></svg>`;

  const buttons = new Map(); // tweetId -> button element

  function styleBtn(btn, st) {
    const posted = st && st.state === "posted";
    const sched = st && st.state === "scheduled";
    btn.innerHTML = posted ? ICON_OK : sched ? ICON_CLOCK : ICON_IN;
    btn.dataset.color = posted ? "rgb(0,186,124)" : sched ? "rgb(10,102,194)" : "rgb(113,118,123)";
    btn.style.color = btn.dataset.color;
    btn.title = posted
      ? "Already on LinkedIn (click to post again)"
      : sched
      ? "Scheduled for LinkedIn: " + new Date(st.at).toLocaleString()
      : "Post to LinkedIn";
  }

  function makeButton(id, art) {
    const wrap = document.createElement("div");
    wrap.className = "xli-btn-wrap";
    wrap.style.cssText = "display:flex;align-items:center;justify-content:center;";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Post to LinkedIn");
    btn.style.cssText =
      "all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;transition:background .15s,color .15s;";
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(10,102,194,.12)";
      btn.style.color = "rgb(10,102,194)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "transparent";
      btn.style.color = btn.dataset.color;
    });
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation(); // don't open the post
      openFor(id, art);
    });
    styleBtn(btn, null);
    wrap.appendChild(btn);
    return { wrap, btn };
  }

  async function openFor(id, art) {
    if (!window.XLIToast) return;
    // make sure there's only one preview open
    document.querySelectorAll("#xli-toast-host").forEach(n => n.remove());

    const dom = window.XLIHarvest ? XLIHarvest.scrapeArticle(art) : null;
    let bundle = { post: null, parts: [], status: null, queued: null };
    try {
      bundle = await send({ type: "postBundle", id });
    } catch {}
    if (!bundle.post && dom) XLIHarvest.save([dom]); // remember it for the dashboard too

    const parts = bundle.parts.length ? bundle.parts.map(p => ({ ...p })) : dom ? [dom] : [];
    if (parts[0] && !(parts[0].images || []).length && dom && dom.images.length) parts[0].images = dom.images;
    if (!parts.length) return;
    const text = parts.map(p => p.text).filter(Boolean).join("\n\n");
    const images = parts.flatMap(p => p.images || []).slice(0, 9).map(bigImg);
    const hasVideo = parts.some(p => p.hasVideo);

    let visualMode = "auto";
    try {
      visualMode = (await send({ type: "getSettings" })).settings.visualMode || "auto";
    } catch {}
    const root = parts[0];
    const ui = XLIToast.open({
      visualMode,
      visual: bundle.queued ? bundle.queued.visual : undefined,
      getCardData: () => XLIParse.cardDataFor({ ...root, images: (root.images || []).map(bigImg) }),
      xText: bundle.queued ? bundle.queued.text : text,
      images,
      hasVideo,
      tweetId: id,
      allowQueue: true,
      title: parts.length > 1 ? `Post thread (${parts.length}) to LinkedIn` : "Post to LinkedIn"
    });
    try {
      const prep = await send({ type: "prepare", text });
      if (bundle.queued) prep.linkedinText = bundle.queued.text;
      ui.ready({ ...prep, mode: "review" }); // manual click: always wait for you
      if (bundle.status?.state === "posted") ui.warn("Already posted to LinkedIn. Posting again makes a duplicate.");
      if (parts.some(p => p.truncated)) ui.warn("Long post: only the preview text was found. Open the post on X first to get the full text, or paste it in.");
    } catch (e) {
      ui.error(e.message);
    }
  }

  function scan() {
    const me = getHandle();
    if (!me || !window.XLIHarvest) return;
    const fresh = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (art.querySelector(":scope .xli-btn-wrap")) continue;
      const rec = XLIHarvest.scrapeArticle(art);
      if (!rec || rec.author !== me || rec.kind === "retweet") continue;
      // the post's own action bar (not one inside a quoted post)
      const bars = [...art.querySelectorAll('div[role="group"]')].filter(g => !g.closest('div[role="link"]'));
      const bar = bars[bars.length - 1];
      if (!bar) continue;
      const { wrap, btn } = makeButton(rec.id, art);
      bar.appendChild(wrap);
      buttons.set(rec.id, btn);
      fresh.push(rec.id);
    }
    if (fresh.length) refreshStates(fresh);
  }

  async function refreshStates(ids) {
    ids = (ids || [...buttons.keys()]).filter(id => buttons.get(id)?.isConnected);
    for (const [id, b] of buttons) if (!b.isConnected) buttons.delete(id);
    if (!ids.length) return;
    try {
      const st = await send({ type: "statusFor", ids });
      for (const id of ids) buttons.get(id) && styleBtn(buttons.get(id), st[id]);
    } catch {}
  }

  let scanT;
  const obs = new MutationObserver(() => {
    clearTimeout(scanT);
    scanT = setTimeout(scan, 250);
  });
  const startObs = () => {
    obs.observe(document.body, { childList: true, subtree: true });
    scan();
  };
  if (document.body) startObs();
  else document.addEventListener("DOMContentLoaded", startObs);

  try {
    chrome.storage.onChanged.addListener(ch => {
      if (ch.myHandle?.newValue) {
        handle = ch.myHandle.newValue.toLowerCase();
        scan();
      }
      if (ch.liStatus || ch.queue) refreshStates();
    });
  } catch {}
})();

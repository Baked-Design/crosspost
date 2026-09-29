// Collects your own X posts as X loads them (profile, timeline, post pages),
// and runs the auto-scroll importer when the dashboard asks for it.
(() => {
  if (window.__xliHarvest) return;
  window.__xliHarvest = true;

  let handle = null;
  let buffer = [];
  let flushTimer = null;
  let lastProfile = "";
  let lastAdded = 0; // for the importer's progress
  let totalMine = 0;

  const send = msg =>
    new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          void chrome.runtime.lastError;
          resolve(res && res.ok ? res.data : null);
        });
      } catch {
        resolve(null); // extension reloaded
      }
    });

  function detectHandle() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const h = a && (a.getAttribute("href") || "").replace(/^\//, "").split(/[/?#]/)[0];
    if (h && h !== handle) {
      handle = h.toLowerCase();
      send({ type: "setHandle", handle });
      scheduleFlush();
    }
    return handle;
  }
  const handleTimer = setInterval(() => detectHandle() && clearInterval(handleTimer), 500);
  // Narrow windows hide the sidebar link, so also use the saved handle
  try {
    chrome.storage.local.get("myHandle", r => {
      if (!handle && r && r.myHandle) {
        handle = r.myHandle.toLowerCase();
        scheduleFlush();
      }
    });
  } catch {}
  let gqlSeen = 0;
  let domSeen = 0;

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  }

  async function flush() {
    if (!handle || !buffer.length) return;
    const mine = buffer.filter(t => t.author === handle && t.kind !== "retweet");
    buffer = [];
    if (!mine.length) return;
    const prof = mine.map(t => t.profile).find(p => p && p.avatar && p.name);
    if (prof && JSON.stringify(prof) !== lastProfile) {
      lastProfile = JSON.stringify(prof);
      send({ type: "setProfile", profile: prof });
    }
    for (const t of mine) delete t.profile;
    const r = await send({ type: "savePosts", posts: mine });
    if (r) {
      lastAdded += r.added;
      totalMine = r.total;
      Importer.update();
    }
  }

  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__xli !== "gql") return;
    try {
      const tweets = XLIParse.fromGraphQL(e.data.json);
      gqlSeen += tweets.length;
      if (tweets.length) {
        buffer.push(...tweets);
        scheduleFlush();
      }
    } catch {}
  });


  // ---------- DOM fallback: read posts straight off the page ----------
  const num = str => {
    const m = String(str || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMm])?/);
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
  };
  const largeImg = u => (u.includes("name=") ? u.replace(/name=\w+/, "name=large") : u + (u.includes("?") ? "&" : "?") + "name=large");

  function scrapeArticle(art) {
    const timeLink = [...art.querySelectorAll('a[href*="/status/"]')].find(a => a.querySelector("time") && !a.closest('div[role="link"]'));
    if (!timeLink) return null;
    const m = timeLink.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const author = m[1].toLowerCase();
    const social = art.querySelector('[data-testid="socialContext"]');
    const isRepost = !!(social && /repost|retweet/i.test(social.innerText));
    const quoteBox = art.querySelector('div[role="link"] [data-testid="tweetText"]');
    const textEl = [...art.querySelectorAll('[data-testid="tweetText"]')].find(el => !el.closest('div[role="link"]'));
    const imgs = [...art.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .filter(i => !i.closest('div[role="link"]'))
      .map(i => i.src)
      .filter(u => /pbs\.twimg\.com\/media/.test(u))
      .map(largeImg);
    const label = sel => art.querySelector(sel)?.getAttribute("aria-label") || "";
    const nameEl = art.querySelector('[data-testid="User-Name"]');
    const avEl = [...art.querySelectorAll('img[src*="profile_images"]')].find(i => !i.closest('div[role="link"]'));
    const profile = {
      handle: author,
      name: nameEl ? (nameEl.innerText.split("\n")[0] || "").trim() : "",
      avatar: avEl ? avEl.src.replace(/_(normal|bigger|x96|200x200)\./, "_400x400.") : "",
      verified: !!(nameEl && nameEl.querySelector('[data-testid="icon-verified"], svg[aria-label*="erified"]'))
    };
    return {
      profile,
      id: m[2],
      author,
      text: textEl ? textEl.innerText.trim() : "",
      createdAt: Date.parse(art.querySelector("time")?.getAttribute("datetime")) || 0,
      likes: num(label('[data-testid="like"], [data-testid="unlike"]')),
      reposts: num(label('[data-testid="retweet"], [data-testid="unretweet"]')),
      replies: num(label('[data-testid="reply"]')),
      views: num(label('a[href$="/analytics"]')),
      images: [...new Set(imgs)],
      hasVideo: !!art.querySelector('[data-testid="videoPlayer"], video'),
      kind: isRepost ? "retweet" : /Replying to/i.test(art.innerText.slice(0, 300)) ? "reply" : quoteBox ? "quote" : "post",
      parentId: null,
      truncated: !!art.querySelector('[data-testid="tweet-text-show-more-link"]'),
      url: `https://x.com/${author}/status/${m[2]}`,
      src: "dom"
    };
  }

  function scrapeDom() {
    const out = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (art.dataset.xliSeen) continue;
      const rec = scrapeArticle(art);
      if (!rec) continue;
      art.dataset.xliSeen = "1";
      if (rec.kind !== "retweet") out.push(rec);
    }
    domSeen += out.length;
    if (out.length) {
      buffer.push(...out);
      scheduleFlush();
    }
  }

  globalThis.XLIHarvest = {
    scrapeArticle,
    handle: () => handle,
    save: posts => {
      buffer.push(...posts);
      scheduleFlush();
    }
  };

  // ---------- auto-scroll importer ----------
  const Importer = {
    running: false,
    ui: null,
    update() {
      if (!this.ui) return;
      this.ui.count.textContent = `${lastAdded} new · ${totalMine} total saved` + (handle ? ` · @${handle}` : " · finding your handle…");
    },
    async start() {
      if (this.running) return;
      this.running = true;
      lastAdded = 0;

      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `
        <style>
          .pill{display:flex;gap:12px;align-items:center;background:#0a66c2;color:#fff;border-radius:999px;padding:10px 12px 10px 18px;
            font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)}
          .c{font-weight:400;opacity:.9}
          button{border:0;border-radius:999px;padding:7px 12px;font:600 13px/1 inherit;cursor:pointer;background:#fff;color:#0a66c2}
        </style>
        <div class="pill"><span class="s">Importing your posts…</span><span class="c">0 new</span><button>Stop</button></div>`;
      document.documentElement.appendChild(host);
      this.ui = { host, status: root.querySelector(".s"), count: root.querySelector(".c"), btn: root.querySelector("button") };
      this.ui.btn.onclick = () => (this.running = false);
      this.update();

      // only learn your handle from your own profile (the one X says you're signed in as), never from any link
      const fromUrl = location.pathname.split("/")[1];
      const signedIn = ((document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') || {}).getAttribute?.("href") || "").replace(/^\//, "").split(/[/?#]/)[0];
      if (fromUrl && !handle && signedIn && fromUrl.toLowerCase() === signedIn.toLowerCase()) {
        handle = fromUrl.toLowerCase();
        send({ type: "setHandle", handle });
      }

      let idle = 0;
      let lastHeight = 0;
      let lastCount = -1;
      while (this.running) {
        scrapeDom();
        window.scrollBy(0, window.innerHeight * 1.6);
        await new Promise(r => setTimeout(r, 1400));
        scrapeDom();

        const retry = [...document.querySelectorAll('button, [role="button"]')].find(b => /^\s*Retry\s*$/i.test(b.innerText || ""));
        if (retry) {
          this.ui.status.textContent = "X is rate limiting, waiting…";
          await new Promise(r => setTimeout(r, 20000));
          retry.click();
          this.ui.status.textContent = "Importing your posts…";
          idle = 0;
          continue;
        }

        const h = document.documentElement.scrollHeight;
        if (h === lastHeight && lastAdded === lastCount) idle++;
        else idle = 0;
        lastHeight = h;
        lastCount = lastAdded;
        if (idle >= 8) break; // reached the end (X stops loading older posts eventually)
      }
      scrapeDom();
      await flush();
      this.running = false;
      this.ui.status.textContent = "Done";
      this.ui.btn.textContent = "Open dashboard";
      this.ui.btn.onclick = () => send({ type: "openDashboard" });
      setTimeout(() => host.remove(), 15000);
      send({ type: "importFinished", added: lastAdded });
    }
  };

  function maybeStartImport() {
    if (location.hash !== "#xli-import") return;
    history.replaceState(null, "", location.pathname + location.search);
    const wait = setInterval(() => {
      if (document.querySelector('[data-testid="primaryColumn"] article, article')) {
        clearInterval(wait);
        Importer.start();
      }
    }, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", maybeStartImport);
  else maybeStartImport();
})();

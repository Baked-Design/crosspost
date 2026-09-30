// Reads how your own LinkedIn posts did (reactions, comments, reposts, impressions) from your activity page,
// only when you open it. Nothing is sent anywhere: it's saved in the extension for the Insights view.
// Your own posts are easy to tell apart: only they have a "View analytics" link.
(() => {
  if (window.__xliLi) return;
  window.__xliLi = true;
  const slugOf = () => (location.pathname.match(/^\/in\/([^/]+)/) || [])[1] || "";
  const onActivity = () => /^\/in\/[^/]+\/recent-activity\//.test(location.pathname);
  const num = s => { const m = String(s || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([km])?/i); if (!m) return 0; return Math.round(+m[1] * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1)); };
  // LinkedIn activity ids carry their own time: the top bits are milliseconds since 1970
  const timeOf = id => { try { return Number(BigInt(id) >> 22n); } catch { return 0; } };
  const send = msg => new Promise(r => { try { chrome.runtime.sendMessage(msg, res => { void chrome.runtime.lastError; r(res && res.ok ? res.data : null); }); } catch { r(null); } });
  const store = keys => new Promise(r => { try { chrome.storage.local.get(keys, v => r(v || {})); } catch { r({}); } });
  const ANALYTICS = 'a[href*="/analytics/post-summary/urn:li:activity:"]';
  const idOf = a => (String(a.href || "").match(/activity:(\d{10,25})/) || [])[1];

  // the post around an analytics link: the biggest box that still holds just that one post
  function boxOf(a) {
    const id = idOf(a);
    let el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      const ids = new Set([...el.parentElement.querySelectorAll('a[href*="urn:li:activity:"]')].map(idOf).filter(Boolean));
      if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
      el = el.parentElement;
    }
    return el;
  }
  // "Jayesh and 2 others reacted" = 3, "Jayesh and 1 other reacted" = 2, "Jayesh reacted" = 1, "12 reactions" = 12
  function reactions(t) {
    let m = t.match(/(?:^|\n)[^\n]*?\band\s+([\d,.]+[km]?)\s+others?\s+reacted/i); if (m) return num(m[1]) + 1;
    m = t.match(/(?:^|[\s·(])([\d,.]+[km]?)\s+reactions?\b/i); if (m) return num(m[1]);
    return /(?:^|\n)[^\n]+\breacted\b/i.test(t) ? 1 : 0;
  }
  function read() {
    const out = [], seen = new Set();
    for (const a of document.querySelectorAll(ANALYTICS)) {
      const id = idOf(a); if (!id || seen.has(id)) continue; seen.add(id);
      const el = boxOf(a), t = el.innerText || "";
      const body = el.querySelector('[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description');
      const text = ((body || {}).innerText || "").replace(/\s*…\s*more\s*$/i, "").trim();
      const count = re => { const m = t.match(re); return m ? num(m[1]) : 0; };
      out.push({
        id, text: text.slice(0, 3000), createdAt: timeOf(id),
        likes: reactions(t),
        comments: count(/(?:^|[\s·(])([\d.,]+[km]?)\s+comments?\b/i),
        reposts: count(/(?:^|[\s·(])([\d.,]+[km]?)\s+reposts?\b/i),
        impressions: count(/(?:^|[\s·(])([\d.,]+[km]?)\s+impressions?\b/i),
        hasImage: [...el.querySelectorAll("img")].some(i => (i.naturalWidth || i.width) > 200),
        hasVideo: !!el.querySelector("video")
      });
    }
    return out;
  }

  let timer = null;
  const flush = async () => { if (!onActivity()) return 0; const posts = read(); if (posts.length) await send({ type: "saveLiPosts", posts }); return posts.length; };
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(flush, 800); }).observe(document.documentElement, { childList: true, subtree: true });

  let importing = false;
  function runImport() {
    if (importing) return; importing = true;
    let steps = 0, last = -1, still = 0;
    const tick = async () => {
      await flush();
      const n = new Set([...document.querySelectorAll(ANALYTICS)].map(idOf)).size;
      still = n === last ? still + 1 : 0; last = n;
      if (++steps < 45 && still < 4) { window.scrollTo(0, document.body.scrollHeight); setTimeout(tick, 1600); }
      else { try { chrome.storage.local.remove("liImportAt"); } catch {} await send({ type: "liImportDone", count: n }); }
    };
    setTimeout(tick, 2000);
  }

  // LinkedIn is one page app: /in/me/ turns into /in/your-name/ without reloading, so keep an eye on the address
  let lastHref = "";
  async function check() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const { liSlug = "", liImportAt = 0 } = await store(["liSlug", "liImportAt"]);
    const slug = slugOf();
    const self = /[?&]isSelfProfile=true/.test(location.search) && slug && slug !== "me";
    if (self && slug !== liSlug) try { chrome.storage.local.set({ liSlug: slug }); } catch {}
    if (!(liImportAt && Date.now() - liImportAt < 10 * 60e3)) return;   // not importing: just read what you look at
    const me = self ? slug : liSlug;
    if (onActivity() && slug !== "me") return runImport();
    if (me && slug === me) location.assign(`/in/${me}/recent-activity/all/`);
  }
  check();
  setInterval(check, 700);
})();

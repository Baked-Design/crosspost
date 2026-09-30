// Reads how your own LinkedIn posts did (reactions, comments, reposts, impressions) from your activity page,
// only when you open it. Nothing is sent anywhere: it's saved in the extension for the Insights view.
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
  let mySlug = "";

  function read() {
    const out = [];
    for (const el of document.querySelectorAll('[data-urn^="urn:li:activity:"]')) {
      const urn = el.getAttribute("data-urn"), id = urn.split(":").pop();
      const head = (el.querySelector(".update-components-header, .feed-shared-header") || {}).innerText || "";
      if (/reposted|commented|likes this|celebrates|loves this|finds this|supports this|replied/i.test(head)) continue;   // someone else's post you reacted to
      const text = ((el.querySelector(".update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text") || {}).innerText || "").trim();
      if (!text) continue;
      const all = el.innerText || "";
      const aria = [...el.querySelectorAll("[aria-label]")].map(x => x.getAttribute("aria-label")).join(" · ");
      const pick = re => { const m = (aria + " · " + all).match(re); return m ? num(m[1]) : 0; };
      out.push({
        urn, id, text: text.slice(0, 3000), createdAt: timeOf(id),
        likes: num((el.querySelector(".social-details-social-counts__reactions-count, .social-details-social-counts__social-proof-fallback-number") || {}).innerText) || pick(/(?:^|[\s·(])([\d.,]+[km]?)\s+reactions?/i),
        comments: pick(/(?:^|[\s·(])([\d.,]+[km]?)\s+comments?/i),
        reposts: pick(/(?:^|[\s·(])([\d.,]+[km]?)\s+reposts?/i),
        impressions: pick(/(?:^|[\s·(])([\d.,]+[km]?)\s+impressions?/i),
        hasImage: !!el.querySelector(".update-components-image, .feed-shared-image"),
        hasVideo: !!el.querySelector("video, .update-components-linkedin-video")
      });
    }
    return out;
  }

  // only your own activity page: someone else's posts never end up in your numbers
  const mine = () => onActivity() && mySlug && slugOf() === mySlug;
  let timer = null;
  const flush = async () => { if (!mine()) return; const posts = read(); if (posts.length) await send({ type: "saveLiPosts", posts }); };
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(flush, 800); }).observe(document.documentElement, { childList: true, subtree: true });

  function runImport() {
    let steps = 0, last = 0, still = 0;
    const tick = async () => {
      await flush();
      const n = document.querySelectorAll('[data-urn^="urn:li:activity:"]').length;
      still = n === last ? still + 1 : 0; last = n;
      if (++steps < 40 && still < 4) { window.scrollTo(0, document.body.scrollHeight); setTimeout(tick, 1600); }
      else { try { chrome.storage.local.remove("liImportAt"); } catch {} await send({ type: "liImportDone", count: n }); }
    };
    setTimeout(tick, 2500);
  }

  (async () => {
    const { liSlug = "", liImportAt = 0 } = await store(["liSlug", "liImportAt"]);
    const slug = slugOf();
    // LinkedIn sends /in/me/ to your real profile (/in/your-name/?isSelfProfile=true): that's how we learn your address
    if (/[?&]isSelfProfile=true/.test(location.search) && slug && slug !== "me") {
      mySlug = slug;
      if (slug !== liSlug) try { chrome.storage.local.set({ liSlug: slug }); } catch {}
    } else mySlug = liSlug;
    if (!(liImportAt && Date.now() - liImportAt < 10 * 60e3)) return;   // not importing: just read what you look at
    if (slug === "me") { if (!/^\/in\/me\/?$/.test(location.pathname)) location.replace("/in/me/"); return; }   // find out who "me" is first
    if (!onActivity() && slug === mySlug) return location.replace(`/in/${mySlug}/recent-activity/all/`);
    if (mine()) runImport();
  })();
})();

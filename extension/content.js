// X to LinkedIn Crosspost: live crosspost on x.com
// Listens for X's own "post created" response (CreateTweet / CreateNoteTweet), which
// says exactly what the post is: a new post, a reply, a quote, or the next part of a thread.
// Nothing fires unless X actually published the post.

(() => {
  if (window.__xliLoaded) return;
  window.__xliLoaded = true;

  let staleShown = false;
  const staleNotice = () => {
    if (staleShown) return;
    staleShown = true;
    const n = document.createElement("div");
    n.textContent = "Crosspost was updated. Reload this tab to keep crossposting.";
    n.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#16140f;color:#fbfaf6;padding:12px 16px;border-radius:12px;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.3)";
    document.documentElement.appendChild(n);
    setTimeout(() => n.remove(), 12000);
  };
  const send = msg =>
    new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) { staleNotice(); return reject(new Error("Extension was updated")); }
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) {
          if (/context invalidated|Receiving end/i.test(chrome.runtime.lastError.message || "")) staleNotice();
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!res) return reject(new Error("No response from extension"));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    });

  const bigImg = u => (u.includes("?") ? u : u + "?name=large");

  function myHandleFromDom() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return ((a && a.getAttribute("href")) || "").replace(/^\//, "").split(/[/?#]/)[0].toLowerCase();
  }

  // Current crosspost session (a single post, or a thread being published part by part)
  let session = null;
  const THREAD_WINDOW_MS = 90_000;
  const GRACE_MS = 2500; // wait for the rest of a thread before preparing

  function createdTweetFrom(json) {
    const d = json && json.data;
    const r = d && (d.create_tweet?.tweet_results?.result || d.notetweet_create?.tweet_results?.result);
    if (!r) return null;
    const t = XLIParse.fromResult(r);
    return t;
  }

  async function onCreated(t) {
    let settings;
    try {
      ({ settings } = await send({ type: "getSettings" }));
    } catch {
      return;
    }
    const me = (settings.myHandle || myHandleFromDom() || "").toLowerCase();
    // fromResult computes kind using the tweet author; re-check self-replies with our handle
    if (t.parentId && t.kind === "reply" && me && t.author === me) t.kind = "thread";

    // Next part of a thread we're already crossposting
    if (t.parentId && session && session.lastId === t.parentId && Date.now() - session.lastAt < THREAD_WINDOW_MS) {
      session.lastId = t.id;
      session.lastAt = Date.now();
      session.ids.push(t.id);
      session.parts.push(t.text);
      session.images.push(...t.images.map(bigImg));
      session.hasVideo = session.hasVideo || t.hasVideo;
      session.onGrow();
      return;
    }

    if (t.parentId && settings.skipReplies) return; // replies (to others, or to your own old posts)
    if (t.kind === "quote" && settings.skipQuotes) return;
    if (settings.skipMarker && t.text.includes(settings.skipMarker)) return;
    if (!t.text && !t.images.length) return;

    const topics = String(settings.topics || "").split(",").map(x => x.trim()).filter(Boolean);
    const fit = XLIParse.linkedinFit(t, topics);
    t.personal = fit.label === "personal" && settings.personalLive !== "post";
    t.personalWhy = fit.why;
    if (t.personal && settings.personalLive === "skip") return;

    startSession(t, settings);
  }

  function startSession(t, settings) {
    const s = {
      rootId: t.id,
      lastId: t.id,
      lastAt: Date.now(),
      ids: [t.id],
      parts: [t.text],
      images: settings.includeImages ? t.images.map(bigImg) : [],
      gen: 0,
      includeImages: settings.includeImages,
      hasVideo: t.hasVideo,
      edited: false,
      prepTimer: null
    };
    s.combined = () => s.parts.filter(Boolean).join("\n\n");
    s.imgs = () => (s.includeImages ? s.images.slice(0, 9) : []);
    session = s;

    const ui = Toast.open({
      xText: s.combined(),
      images: s.imgs(),
      hasVideo: s.hasVideo,
      tweetId: s.rootId,
      getImages: s.imgs,
      getXText: s.combined,
      onEdit: () => (s.edited = true),
      visualMode: settings.visualMode,
      getCardData: () => XLIParse.cardDataFor({ text: s.parts[0], createdAt: t.createdAt, images: t.images.map(bigImg) }),
      onDone: () => session === s && (session = null)
    });

    // Scripts on x.com can fake "a post was created" messages, so nothing here is trusted until X confirms it:
    // the post exists, it's yours, and its text matches. Only a confirmed single post may post on its own
    // (and only then are its photos, taken from X, and a Claude rewrite used). Threads always wait for a click.
    const prepare = async () => {
      const gen = ++s.gen;
      ui.update({ xText: s.combined(), images: s.imgs(), hasVideo: s.hasVideo, keepText: s.edited });
      try {
        const v = await send({ type: "verifyTweet", id: s.rootId, text: s.parts[0], handle: myHandleFromDom() }).catch(() => ({ ok: false }));
        if (gen !== s.gen) return; // a newer thread part arrived: that run takes over
        if (v.ok && s.ids.length === 1) {
          s.images = s.includeImages ? (v.images || []).map(bigImg) : [];
          ui.update({ xText: s.combined(), images: s.imgs(), hasVideo: s.hasVideo, keepText: true });
        }
        const prep = await send({ type: "prepare", text: s.combined(), rewrite: !!v.ok });
        if (gen !== s.gen) return;
        if (s.edited) prep.linkedinText = null; // don't overwrite your edits
        let why = "";
        if (t.personal) { prep.mode = "review"; why = "This looks personal. Post it to LinkedIn anyway?"; }
        else if (prep.mode !== "review" && s.ids.length > 1) { prep.mode = "review"; why = "Threads wait for you. Check it, then press Post."; }
        else if (prep.mode !== "review" && !v.ok) { prep.mode = "review"; why = "Couldn't confirm this post with X, so it waits for you. Press Post to send it."; }
        ui.ready(prep);
        if (why) ui.warn(why);
      } catch (e) {
        if (gen === s.gen) ui.error(e.message);
      }
    };
    s.onGrow = () => {
      if (ui.isDone()) return;
      ui.pause("Thread detected…");
      clearTimeout(s.prepTimer);
      s.prepTimer = setTimeout(prepare, GRACE_MS);
    };
    s.prepTimer = setTimeout(prepare, GRACE_MS);
  }

  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__xli !== "gql") return;
    if (e.data.op !== "CreateTweet" && e.data.op !== "CreateNoteTweet") return;
    const t = createdTweetFrom(e.data.json);
    if (t) onCreated(t);
  });

  // ---------- toast UI (shadow DOM so X's CSS can't touch it) ----------
  const Toast = {
    active: null,
    // closing a pop-up always stops its countdown: nothing is ever posted from a pop-up you can't see
    closeActive() {
      if (Toast.active) Toast.active.kill();
      Toast.active = null;
      document.querySelectorAll("#xli-toast-host").forEach(n => n.remove());
    },
    open({ xText, images, hasVideo, tweetId, getImages, getXText, onEdit, onDone, allowQueue, title, visual, visualMode, getCardData }) {
      Toast.closeActive();
      const host = document.createElement("div");
      host.id = "xli-toast-host";
      host.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" }); // closed: scripts on x.com can't reach in and press Post
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .card { --bg:#fffefb; --text:#16140f; --muted:#6b655b; --line:#e2ddd3; --soft:#f4f2ed; --field:#f9f7f3; --primary:#16140f; --pfg:#fbfaf6; --accent:#16140f;
            width: 392px; background:var(--bg); color:var(--text); border-radius:20px; border:1px solid var(--line);
            box-shadow:0 1px 0 rgba(22,20,15,.04), 0 32px 64px -24px rgba(22,20,15,.35), 0 12px 24px -12px rgba(22,20,15,.12);
            font:14px/1.5 "XLI Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; letter-spacing:-.006em; -webkit-font-smoothing:antialiased;
            overflow:hidden; animation: in .2s ease; }
          :host([data-theme="dark"]) .card { --bg:#16181c; --text:#e7e9ea; --muted:#8b98a5; --line:#2f3336; --soft:#1d1f23; --field:#0f1113; --primary:#eff3f4; --pfg:#0f1419; --accent:#eff3f4;
            box-shadow:0 24px 64px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04); }
          @keyframes in { from { opacity:0; transform: translateY(8px); } }
          .head { display:flex; align-items:baseline; gap:9px; padding:16px 18px 12px; font-family:"XLI Glyphic",Georgia,serif; font-weight:400; font-size:19px; letter-spacing:-.015em; }
          .li { display:none; }

          .status { margin-left:auto; font-family:"XLI Inter",sans-serif; font-weight:500; font-size:11.5px; letter-spacing:0; color:var(--muted); }
          .status:empty { display:none; }
          .body { padding:0 18px 14px; }
          textarea { display:block; width:100%; box-sizing:border-box; min-height:120px; max-height:260px; resize:vertical;
            border:1px solid var(--line); border-radius:12px; padding:12px 13px; font:inherit; line-height:1.55; color:inherit; background:var(--field); outline:none; }
          textarea:focus { border-color:var(--muted); box-shadow:0 0 0 3px color-mix(in srgb, var(--text) 10%, transparent); }
          .meta { font-size:12px; color:var(--muted); }
          .vis { display:flex; align-items:center; gap:10px; margin-top:10px; }
          .vis select { font:inherit; font-size:12.5px; font-weight:500; height:30px; padding:0 10px; border-radius:999px; border:1px solid var(--line); background:var(--bg); color:inherit; cursor:pointer; }
          .thumb { width:40px; height:50px; object-fit:cover; border-radius:6px; border:1px solid var(--line); cursor:zoom-in; }
          .big { position:fixed; right:420px; bottom:20px; width:300px; border-radius:12px; box-shadow:0 24px 64px rgba(0,0,0,.35); border:1px solid var(--line); }
          .warn { font-size:12px; color:#b45309; margin-top:8px; }
          .err { font-size:12px; color:#dc2626; margin-top:8px; white-space:pre-wrap; }
          .row { display:flex; gap:6px; padding:0 18px 18px; }
          button { flex:1; height:38px; border-radius:999px; padding:0 14px; font:500 13.5px/1 "XLI Inter",sans-serif; letter-spacing:-.01em; cursor:pointer; border:1px solid var(--line); background:var(--bg); color:var(--text); transition: filter .12s; }
          button:hover { filter: brightness(.97); }
          .primary { background:var(--primary); border-color:var(--primary); color:var(--pfg); }
          .primary:disabled, button:disabled { opacity:.5; cursor:default; }
          .ghost { background:var(--bg); }
          .skip { flex:0 0 auto; background:transparent; border-color:transparent; color:var(--muted); }
          .bar { height:2px; background:var(--text); opacity:.8; width:100%; transform-origin:left; }
          .body > a, a { color:var(--accent); font-weight:600; text-decoration:none; }
          .spin { opacity:.75; }
          .done { display:flex; align-items:center; gap:10px; padding:2px 0 4px; font-weight:500; }
          .done .ok { width:22px; height:22px; border-radius:50%; background:color-mix(in srgb, #22a35a 16%, transparent); color:#22a35a; display:grid; place-items:center; flex:none; animation: pop .45s cubic-bezier(.34,1.56,.64,1) both; }
          .done .ok svg { width:13px; height:13px; }
          .done .ok path { fill:none; stroke:currentColor; stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round; stroke-dasharray:20; stroke-dashoffset:20; animation: draw .35s cubic-bezier(.2,.8,.2,1) .1s forwards; }
          .done > span:nth-child(2), .done a { animation: rise .45s cubic-bezier(.2,.8,.2,1) .08s both; }
          .sp { display:inline-block; width:12px; height:12px; border-radius:50%; border:2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color:currentColor; animation: rot .7s linear infinite; vertical-align:-2px; margin-right:6px; }
          .card.shake { animation: shake .45s cubic-bezier(.36,.07,.19,.97) both; }
          @keyframes pop { from { transform:scale(.4); } to { transform:scale(1); } }
          @keyframes draw { to { stroke-dashoffset:0; } }
          @keyframes rise { from { opacity:0; transform:translateY(6px); filter:blur(4px); } to { opacity:1; transform:none; filter:none; } }
          @keyframes rot { to { transform:rotate(360deg); } }
          @keyframes shake { 10%,90% { transform:translateX(-1px); } 20%,80% { transform:translateX(3px); } 30%,50%,70% { transform:translateX(-6px); } 40%,60% { transform:translateX(6px); } }
          @media (prefers-reduced-motion: reduce) { .done .ok, .done .ok path, .done > span, .done a, .card.shake, .sp { animation:none !important; stroke-dashoffset:0; } }
        </style>
        <div class="card">
          <div class="bar" part="bar" style="transform:scaleX(0)"></div>
          <div class="head"><span class="li"><svg viewBox="0 0 24 24"><path d="M5 5l6 7-6 7M13 19h6"/></svg></span> To LinkedIn <span class="status"></span></div>
          <div class="body">
            <textarea disabled></textarea>
            <div class="vis">
              <img class="thumb" hidden alt="">
              <select title="What image goes with the LinkedIn post">
                <option value="images">Post images</option>
                <option value="none">Text only</option>
                <option value="card">Tweet card</option>
              </select>
              <span class="meta"></span>
            </div>
            <img class="big" hidden alt="">
            <div class="warn" hidden></div>
            <div class="err" hidden></div>
          </div>
          <div class="row">
            <button class="ghost skip">Skip</button>
            <button class="ghost queue" hidden>Queue</button>
            <button class="primary post" disabled>Post</button>
          </div>
        </div>`;
      if (!document.getElementById("xli-fonts")) {
        const st = document.createElement("style");
        st.id = "xli-fonts";
        const u = f => chrome.runtime.getURL("fonts/" + f);
        st.textContent = [400, 500, 600]
          .map(w => `@font-face{font-family:"XLI Inter";font-weight:${w};font-display:swap;src:url(${u(`inter-${w}.woff2`)}) format("woff2")}`)
          .join("") + `@font-face{font-family:"XLI Glyphic";font-weight:400;font-display:swap;src:url(${u("faculty-glyphic-400.woff2")}) format("woff2")}`;
        document.documentElement.appendChild(st);
      }
      try {
        const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
        const lum = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255;
        host.setAttribute("data-theme", lum < 0.5 ? "dark" : "light");
      } catch {}
      document.documentElement.appendChild(host);

      const $ = s => root.querySelector(s);
      const ta = $("textarea");
      const status = $(".status");
      const bar = $(".bar");
      const postBtn = $(".post");
      const skipBtn = $(".skip");
      const queueBtn = $(".queue");
      if (title) root.querySelector(".head").childNodes[1].textContent = " " + title + " ";
      if (allowQueue) {
        queueBtn.hidden = false;
        skipBtn.textContent = "Cancel";
      }
      const warn = $(".warn");
      const err = $(".err");

      const sel = $(".vis select");
      const thumb = $(".thumb");
      const big = $(".big");
      let curImgs = images || [];
      const pickImgs = () => (getImages ? getImages() : curImgs);
      let vis = visual || (window.XLIParse ? XLIParse.visualFor(visualMode || "auto", curImgs.length > 0) : curImgs.length ? "images" : "none");
      let cardKey = "";
      const renderThumb = async () => {
        if (vis === "none") {
          thumb.hidden = true;
          return;
        }
        if (vis === "images") {
          thumb.src = pickImgs()[0];
          thumb.hidden = false;
          return;
        }
        const cd = getCardData && getCardData();
        const key = JSON.stringify(cd);
        if (!cd || key === cardKey) return;
        cardKey = key;
        try {
          const r = await send({ type: "renderCard", cardData: cd });
          if (cardKey === key && vis === "card") {
            thumb.src = r.dataUrl;
            thumb.hidden = false;
          }
        } catch {}
      };
      thumb.addEventListener("mouseenter", () => {
        big.src = thumb.src;
        big.hidden = false;
      });
      thumb.addEventListener("mouseleave", () => (big.hidden = true));
      const renderMeta = (imgs, vid) => {
        curImgs = imgs || [];
        sel.querySelector('option[value="images"]').disabled = !curImgs.length;
        sel.querySelector('option[value="card"]').disabled = !getCardData;
        if (vis === "images" && !curImgs.length) vis = "none";
        if (vis === "card" && !getCardData) vis = curImgs.length ? "images" : "none";
        sel.value = vis;
        $(".meta").textContent = vis === "images" ? `${curImgs.length} image${curImgs.length > 1 ? "s" : ""}` : vis === "card" ? "screenshot of your post" : "";
        warn.hidden = !vid || vis === "card";
        warn.textContent = "Video/GIF isn't carried over.";
        cardKey = vis === "card" ? cardKey : "";
        renderThumb();
      };
      sel.addEventListener("change", () => {
        vis = sel.value;
        if (timer) stopCountdown();
        renderMeta(curImgs, hasVideo);
      });
      const visualPayload = () => ({
        images: vis === "images" ? pickImgs() : [],
        visual: vis,
        cardData: vis === "card" && getCardData ? getCardData() : null
      });
      ta.value = xText;
      status.textContent = "Preparing…";
      status.classList.add("spin");
      renderMeta(images, hasVideo);

      let timer = null;
      let done = false;

      const close = (delay = 0) => {
        onDone && onDone();
        setTimeout(() => host.remove(), delay);
      };
      const stopCountdown = () => {
        if (timer) clearInterval(timer);
        timer = null;
        bar.style.transition = "none";
        bar.style.transform = "scaleX(0)";
        if (!done) status.textContent = "Review";
      };

      const doPost = async () => {
        if (done || !host.isConnected) return;
        done = true;
        stopCountdown();
        postBtn.disabled = true;
        skipBtn.disabled = true;
        ta.disabled = true;
        status.innerHTML = '<span class="sp"></span>Posting…';
        err.hidden = true;
        try {
          const r = await send({ type: "publish", text: ta.value.trim(), ...visualPayload(), xText: getXText ? getXText() : xText, tweetId });
          status.textContent = "";
          $(".body").innerHTML = `<div class="done"><span class="ok"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span style="flex:1">Posted to LinkedIn${r.imageCount ? ` with ${r.visual === "card" ? "tweet card" : r.imageCount + " image" + (r.imageCount > 1 ? "s" : "")}` : ""}</span><a href="${r.url}" target="_blank" rel="noopener">View post</a></div>`;
          $(".row").remove();
          close(6000);
        } catch (e) {
          done = false;
          postBtn.disabled = false;
          skipBtn.disabled = false;
          ta.disabled = false;
          postBtn.textContent = "Retry";
          status.textContent = "Failed";
          showError(e.message);
          const card = $(".card"); card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
        }
      };

      const showError = msg => {
        err.hidden = false;
        err.textContent = msg;
        if (/settings|connect|Reconnect|Client ID/i.test(msg)) {
          const a = document.createElement("a");
          a.href = "#";
          a.textContent = " Open settings";
          a.onclick = ev => {
            ev.preventDefault();
            send({ type: "openOptions" });
          };
          err.appendChild(a);
        }
      };

      skipBtn.onclick = e => {
        if (!e.isTrusted) return;
        done = true;
        stopCountdown();
        send({ type: "skipped", xText: getXText ? getXText() : xText }).catch(() => {});
        close();
      };
      postBtn.onclick = e => e.isTrusted && doPost();
      queueBtn.onclick = async e => {
        if (!e.isTrusted || done) return;
        stopCountdown();
        const text = ta.value.trim();
        if (!text) return showError("Add some text first.");
        queueBtn.disabled = postBtn.disabled = true;
        try {
          const r = await send({ type: "enqueue", items: [{ tweetId, text, ...visualPayload() }] });
          done = true;
          const when = new Date(r.added[0].at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          status.textContent = "";
          $(".body").innerHTML = `<div class="done"><span class="ok"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span><span></span></div>`;
          $(".body .done span:last-child").textContent = `Queued for ${when}`;
          $(".row").remove();
          close(4000);
        } catch (e) {
          queueBtn.disabled = postBtn.disabled = false;
          showError(e.message);
        }
      };
      // Any interaction with the text pauses the countdown so you can edit.
      ["focus", "input", "mousedown"].forEach(ev => ta.addEventListener(ev, () => timer && stopCountdown()));
      ta.addEventListener("input", () => onEdit && onEdit());

      const api = {
        kill() {
          done = true;
          if (timer) clearInterval(timer);
          timer = null;
          onDone && onDone();
          host.remove();
          if (Toast.active === api) Toast.active = null;
        },
        ready({ linkedinText, rewriteError, mode, countdownSeconds }) {
          if (done) return;
          if (timer) clearInterval(timer); // never two countdowns at once
          timer = null;
          status.classList.remove("spin");
          if (linkedinText != null) ta.value = linkedinText;
          ta.disabled = false;
          postBtn.disabled = false;
          if (rewriteError) showError("Claude rewrite failed, using original: " + rewriteError);

          if (mode === "instant") return doPost();
          if (mode === "countdown" && countdownSeconds > 0) {
            let left = countdownSeconds;
            status.textContent = `Posting in ${left}s`;
            requestAnimationFrame(() => {
              bar.style.transform = "scaleX(1)";
              requestAnimationFrame(() => {
                bar.style.transition = `transform ${countdownSeconds}s linear`;
                bar.style.transform = "scaleX(0)";
              });
            });
            timer = setInterval(() => {
              if (!host.isConnected) {
                // the pop-up was removed (another preview opened, X redrew the page): stop, don't post
                stopCountdown();
                done = true;
                onDone && onDone();
                return;
              }
              left -= 1;
              if (left <= 0) {
                clearInterval(timer);
                timer = null;
                doPost();
              } else status.textContent = `Posting in ${left}s`;
            }, 1000);
          } else {
            status.textContent = "Review";
          }
        },
        warn(msg) {
          warn.hidden = false;
          warn.textContent = msg;
        },
        isDone() {
          return done;
        },
        pause(label) {
          if (timer) clearInterval(timer);
          timer = null;
          bar.style.transition = "none";
          bar.style.transform = "scaleX(0)";
          status.textContent = label;
          status.classList.add("spin");
        },
        update({ xText: t, images: imgs, hasVideo: vid, keepText }) {
          if (!keepText) ta.value = t;
          renderMeta(imgs, vid);
        },
        error(msg) {
          status.classList.remove("spin");
          status.textContent = "Error";
          ta.disabled = false;
          postBtn.disabled = false;
          showError(msg);
        }
      };
      Toast.active = api;
      return api;
    }
  };
  globalThis.XLIToast = Toast;
})();

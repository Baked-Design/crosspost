// X to LinkedIn Crosspost: background service worker
// Handles LinkedIn OAuth, the optional Claude rewrite, image upload and posting.
importScripts("card.js", "slots.js");

const PLAYBOOK_INSTRUCTIONS =
  "Rewrite this X post as a LinkedIn post in my voice: casual, direct, plain words, no corporate fluff, no jargon.\n" +
  "Structure:\n" +
  "- Line 1 is the hook and carries the promise: something I lived, my proof, an outcome and who it was for, or a contrast from my own life. Keep it under 70 characters if you can.\n" +
  "- Line 2 gives a second reason to keep reading (a sub-hook). Leave a blank line after it.\n" +
  "- Then short lines with lots of white space. One idea per line.\n" +
  "- If it fits, end with a short P.S. line.\n" +
  "Rules: never invent facts, numbers, clients or results that aren't in the original. A little punch in the hook is fine, never a lie. " +
  "Never use em dashes. Max 2 hashtags, only if they add value. Turn @handles into plain names. If it's a thread, merge it into one flowing post. " +
  "It must not read like generic AI content: keep the specific, lived details from the original.";

const DEFAULTS = {
  clientId: "",
  clientSecret: "",
  mode: "countdown", // "countdown" | "review" | "instant"
  countdownSeconds: 10,
  skipReplies: true,
  skipQuotes: true,
  skipMarker: "", // e.g. "#xonly": if an X post contains it, don't crosspost
  includeImages: true,
  rewriteEnabled: false,
  anthropicKey: "",
  anthropicModel: "", // blank = auto-pick latest Sonnet
  rewriteInstructions: PLAYBOOK_INSTRUCTIONS,
  visualMode: "auto", // "auto" (the post's own images, else text only) | "card" | "images" | "none"
  cardTheme: "light", // "light" | "dark"
  postsPerWeek: 3,
  runStart: 0, // start of the current 12-week run (ms); 0 = not started
  hidePersonal: true, // only suggest work-related posts
  topics: "", // what you post about on LinkedIn, comma separated (helps the fit check)
  screenWithClaude: true, // if an Anthropic key is set, let Claude judge unclear posts
  personalLive: "ask", // live crosspost of a personal-looking X post: "ask" | "skip" | "post"
  myHandle: "", // auto-detected from x.com
  slotTimes: "09:00-11:00", // windows or exact times, local, comma separated. One post per window per day.
  slotDays: [1, 2, 3, 4, 5], // 0 = Sun ... 6 = Sat
  slotNatural: true, // windows post at a natural minute (9:17), not on the hour
  slotSeed: "" // per-install salt so everyone's natural minutes differ
};

const HISTORY_MAX = 1000;

// ---------- storage helpers ----------
async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}
async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  return auth || null;
}
// history and posted records are read, changed and written back: one at a time, so two posts
// finishing together can't overwrite each other
let recChain = Promise.resolve();
function recLock(fn) {
  const run = recChain.then(fn, fn);
  recChain = run.catch(() => {});
  return run;
}
function addHistory(entry) {
  return recLock(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift({ at: Date.now(), ...entry });
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
  });
}

// ---------- LinkedIn OAuth ----------
async function connectLinkedIn() {
  const { clientId, clientSecret } = await getSettings();
  if (!clientId || !clientSecret) throw new Error("Add your LinkedIn Client ID and Secret first.");

  const redirectUri = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
  const state = crypto.randomUUID();
  const authUrl =
    "https://www.linkedin.com/oauth/v2/authorization?" +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: "openid profile w_member_social"
    });

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const params = new URL(responseUrl).searchParams;
  if (params.get("error")) throw new Error(params.get("error_description") || params.get("error"));
  if (params.get("state") !== state) throw new Error("OAuth state mismatch, try again.");

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code"),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    })
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) {
    throw new Error("Token exchange failed: " + (token.error_description || tokenRes.status));
  }

  const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: "Bearer " + token.access_token }
  });
  const me = await meRes.json();
  if (!meRes.ok || !me.sub) throw new Error("Couldn't read your LinkedIn profile.");

  const auth = {
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in || 5184000) * 1000,
    personUrn: "urn:li:person:" + me.sub,
    name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" "),
    picture: me.picture || ""
  };
  await chrome.storage.local.set({ auth });
  return { name: auth.name, expiresAt: auth.expiresAt };
}

async function requireAuth() {
  const auth = await getAuth();
  if (!auth) throw new Error("LinkedIn not connected. Open the extension settings to connect.");
  if (Date.now() > auth.expiresAt - 60_000) {
    throw new Error("LinkedIn login expired (they last 60 days). Reconnect in the extension settings.");
  }
  return auth;
}

// ---------- LinkedIn API ----------
// LinkedIn's versioned API needs a YYYYMM version header, and old versions get sunset.
// We try the current month and walk backwards until one is accepted, then remember it.
function recentVersions(n = 12) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

async function liFetch(path, { method = "GET", body, auth }) {
  const { liVersion } = await chrome.storage.local.get("liVersion");
  const versions = liVersion ? [liVersion, ...recentVersions().filter(v => v !== liVersion)] : recentVersions();
  let lastErr;
  for (const v of versions) {
    const res = await fetch("https://api.linkedin.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + auth.accessToken,
        "LinkedIn-Version": v,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.ok) {
      if (v !== liVersion) await chrome.storage.local.set({ liVersion: v });
      return res;
    }
    const text = await res.text();
    // Version not active (too new or sunset): try the next one.
    if (res.status === 426 || /NONEXISTENT_VERSION|VERSION_MISSING|version/i.test(text) && res.status === 400) {
      lastErr = new Error(`LinkedIn version ${v} rejected`);
      continue;
    }
    if (res.status === 401) throw new Error("LinkedIn token rejected. Reconnect in settings.");
    throw new Error(`LinkedIn error ${res.status}: ${text.slice(0, 300)}`);
  }
  throw lastErr || new Error("No LinkedIn API version accepted.");
}

// Download an image from X. Tries a few size variants, and refuses anything
// that isn't actually an image (X sometimes answers with an error page).
async function fetchImageBlob(src) {
  if (src instanceof Blob) return src;
  if (typeof src !== "string") throw new Error("Bad image reference");
  if (src.startsWith("data:")) return (await fetch(src)).blob();
  // only X's own image servers: a fake post can't make Crosspost download from anywhere else
  let u; try { u = new URL(src); } catch (e) { throw new Error("Bad image reference"); }
  if (u.protocol !== "https:" || !/(^|\.)twimg\.com$/.test(u.hostname)) throw new Error("That image isn't from X. Try \"Tweet card\" or \"Text only\".");
  const variants = [src];
  if (/pbs\.twimg\.com\/media\//.test(src)) {
    const base = src.split("?")[0];
    const fmt = (src.match(/format=(\w+)/) || base.match(/\.(jpg|jpeg|png|webp)$/i) || [])[1] || "jpg";
    const id = base.replace(/\.(jpg|jpeg|png|webp)$/i, "");
    variants.push(`${id}?format=${fmt}&name=large`, `${id}?format=${fmt}&name=orig`, `${id}?format=${fmt}&name=medium`, `${id}.${fmt}`);
  }
  let lastErr = "";
  for (const url of [...new Set(variants)]) {
    try {
      const res = await fetch(url, { credentials: "omit" });
      const type = res.headers.get("content-type") || "";
      if (res.ok && !/text\/|json|xml/i.test(type)) {
        const blob = await res.blob();
        if (blob.size > 0) return blob;
      }
      lastErr = `HTTP ${res.status} ${type}`;
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`Couldn't download the image from X (${lastErr}). Try "Tweet card" or "Text only".`);
}

async function waitForImage(urn, auth) {
  // LinkedIn processes uploads async; posting before it's AVAILABLE can drop the image.
  // If we're not allowed to read the status (403/404 etc.), just give it a short head start.
  const { liVersion } = await chrome.storage.local.get("liVersion");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch("https://api.linkedin.com/rest/images/" + encodeURIComponent(urn), {
        headers: {
          Authorization: "Bearer " + auth.accessToken,
          "LinkedIn-Version": liVersion || recentVersions()[1],
          "X-Restli-Protocol-Version": "2.0.0"
        }
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    let st = "";
    try {
      const j = await res.json();
      st = j.status || j.value?.status || "";
    } catch {}
    if (st === "AVAILABLE" || !st) return;
    if (st === "PROCESSING_FAILED") throw new Error("LinkedIn couldn't process the image.");
    await new Promise(r => setTimeout(r, 1200));
  }
  await new Promise(r => setTimeout(r, 2000));
}

async function uploadImage(src, auth) {
  const blob = await fetchImageBlob(src);
  const init = await liFetch("/rest/images?action=initializeUpload", {
    method: "POST",
    auth,
    body: { initializeUploadRequest: { owner: auth.personUrn } }
  });
  const { value } = await init.json();
  if (!value?.uploadUrl) throw new Error("LinkedIn didn't return an upload URL for the image.");
  const put = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: "Bearer " + auth.accessToken, "Content-Type": blob.type || "image/jpeg" },
    body: blob
  });
  if (!put.ok) throw new Error(`LinkedIn rejected the image upload (${put.status}).`);
  await waitForImage(value.image, auth);
  return value.image; // urn:li:image:...
}

// LinkedIn "little text" format: these characters must be backslash-escaped
// or the post fails / gets cut off.
// Hashtags are turned into LinkedIn's clickable hashtag syntax.
function escapeLittleText(s) {
  return s
    .replace(/[\\|{}@\[\]()<>#*_~]/g, m => "\\" + m)
    .replace(/(^|[^\w\\])\\#([\p{L}\p{N}_]+)/gu, (_, pre, tag) => `${pre}{hashtag|\\#|${tag}}`);
}

// visual: "card" renders the tweet card, "none" posts text only, anything else uses `images`
async function resolveVisual({ images = [], visual, cardData }) {
  if (visual === "none") return [];
  if (visual === "card" && cardData) return [await renderCard(cardData)];
  return images;
}

async function renderCard(cardData) {
  const s = await getSettings();
  const { xProfile = {} } = await chrome.storage.local.get("xProfile");
  return XLICard.renderTweetCard({
    theme: s.cardTheme,
    name: xProfile.name,
    handle: xProfile.handle || s.myHandle,
    avatar: xProfile.avatar,
    verified: xProfile.verified,
    ...cardData
  });
}

async function publishToLinkedIn({ text, images = [], visual, cardData }) {
  if (String(text || "").length > 3000) throw new Error(`This post is ${String(text).length.toLocaleString()} characters. LinkedIn allows 3,000: open it in the dashboard and trim it.`);
  images = await resolveVisual({ images, visual, cardData });
  const auth = await requireAuth();
  const imageUrns = [];
  for (const img of (images || []).filter(Boolean).slice(0, 9)) imageUrns.push(await uploadImage(img, auth));

  const post = {
    author: auth.personUrn,
    commentary: escapeLittleText(text),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  };
  if (imageUrns.length === 1) post.content = { media: { id: imageUrns[0] } };
  if (imageUrns.length > 1) post.content = { multiImage: { images: imageUrns.map(id => ({ id })) } };

  const res = await liFetch("/rest/posts", { method: "POST", auth, body: post });
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
  const url = urn ? "https://www.linkedin.com/feed/update/" + urn + "/" : "https://www.linkedin.com/in/me/recent-activity/all/";
  return { urn, url, imageCount: imageUrns.length, visual: visual || (imageUrns.length ? "images" : "none") };
}

// ---------- Claude rewrite ----------
async function pickModel(key) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    }
  });
  if (!res.ok) throw new Error("Couldn't list Claude models (" + res.status + ")");
  const { data = [] } = await res.json();
  // API returns newest first
  const sonnet = data.find(m => /sonnet/i.test(m.id));
  return (sonnet || data[0])?.id;
}

async function rewriteWithClaude(text, s) {
  if (!s.anthropicKey) throw new Error("Claude rewrite is on but no Anthropic API key is set.");
  let model = s.anthropicModel;
  if (!model) {
    model = await pickModel(s.anthropicKey);
    await chrome.storage.local.set({ anthropicModel: model });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system:
        s.rewriteInstructions +
        "\n\nReturn ONLY the final LinkedIn post text. No preamble, no quotes, no explanation.",
      messages: [{ role: "user", content: text }]
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Claude error: " + (json.error?.message || res.status));
  return json.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
}

// ---------- old posts, queue, scheduler ----------
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

async function getStore() {
  const { xposts = {}, liStatus = {}, queue = [] } = await chrome.storage.local.get(["xposts", "liStatus", "queue"]);
  return { xposts, liStatus, queue };
}

// the next n open slots, skipping any window that already has something queued
function nextFreeSlots(n, queue, s) {
  if (!XLISlots.valid(s.slotTimes)) throw new Error("Set your posting times in Queue → Schedule.");
  const out = XLISlots.upcoming(s, queue, n).map(x => x.at);
  if (out.length < n) throw new Error("No open slots in the next two years. Add days or times in Queue → Schedule.");
  return out;
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/128.png", title, message: message.slice(0, 200) });
  } catch {}
}

function recordPosted(tweetId, info) {
  if (!tweetId) return Promise.resolve();
  return recLock(async () => {
    const { liStatus = {} } = await chrome.storage.local.get("liStatus");
    if (liStatus[tweetId]?.state === "posted" && info.state !== "posted") return; // a later failure never hides that it went out
    liStatus[tweetId] = { ...liStatus[tweetId], ...info };
    await chrome.storage.local.set({ liStatus });
  });
}

// one post, one publish: whoever claims a post first (Post now, the scheduler, the live pop-up)
// publishes it; anyone else gets a clear message instead of a duplicate on LinkedIn
const inflight = new Set();
function claim(tweetId) {
  if (!tweetId) return true;
  if (inflight.has(tweetId)) return false;
  inflight.add(tweetId);
  return true;
}
const release = tweetId => tweetId && inflight.delete(tweetId);

// a post that was mid-publish when Chrome closed or the extension restarted can't stay
// "Posting…" forever. We can't know if LinkedIn got it, so it's marked for you to check, never re-sent.
const STUCK_MS = 5 * 60 * 1000;
const LATE_MS = 6 * 3600 * 1000;
async function recoverStuck() {
  await withLock(async () => {
    const { queue } = await getStore();
    let changed = false;
    for (const q of queue) {
      if (q.status === "posting" && !inflight.has(q.tweetId) && Date.now() - (q.postingAt || 0) > STUCK_MS) {
        Object.assign(q, { status: "failed", error: "Interrupted while posting. Check LinkedIn first: if it's not there, press Post now." });
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ queue });
  });
}

let ticking = false;
async function processQueue() {
  if (ticking) return;
  ticking = true;
  try {
    // Pick one due item per tick so a backlog (e.g. Chrome was closed) trickles out.
    const item = await withLock(async () => {
      const { queue } = await getStore();
      const { liStatus } = await getStore();
      const due = queue
        .filter(q => q.status === "scheduled" && q.at <= Date.now() && !inflight.has(q.tweetId))
        .sort((a, b) => a.at - b.at)[0];
      if (!due) return null;
      if (liStatus[due.tweetId]?.state === "posted" && liStatus[due.tweetId].at > (due.queuedAt || 0)) {
        // already went out another way (Post now, the live pop-up) after it was queued: drop it, don't post twice
        await chrome.storage.local.set({ queue: queue.filter(q => q.qid !== due.qid) });
        return null;
      }
      if (Date.now() - due.at > LATE_MS) {
        // missed while Chrome was closed or the Mac was asleep: don't dump a backlog on LinkedIn, move it to the next open slot
        const s = await getSettings();
        const [next] = XLISlots.upcoming(s, queue.filter(q => q.qid !== due.qid), 1);
        if (next) {
          Object.assign(due, { at: next.at, note: "Moved: Chrome was closed when it was due" });
          await chrome.storage.local.set({ queue: queue.sort((m, n) => m.at - n.at) });
          notify("Crosspost moved a missed post", `It was due while Chrome was closed. New time: ${new Date(next.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
          return null;
        }
      }
      if (!claim(due.tweetId)) return null;
      Object.assign(due, { status: "posting", postingAt: Date.now() });
      await chrome.storage.local.set({ queue });
      return { ...due };
    });
    if (!item) return;

    try {
      const r = await publishToLinkedIn({ text: item.text, images: item.images || [], visual: item.visual, cardData: item.cardData });
      await withLock(async () => {
        const { queue } = await getStore();
        await chrome.storage.local.set({ queue: queue.filter(q => q.qid !== item.qid) });
      });
      await recordPosted(item.tweetId, { state: "posted", url: r.url, at: Date.now(), text: item.text, images: (item.images || []).slice(0, 4), visual: r.visual });
      await addHistory({ ok: true, xText: item.text, text: item.text, url: r.url, scheduled: true });
      notify("Posted to LinkedIn", item.text);
    } catch (e) {
      await withLock(async () => {
        const { queue } = await getStore();
        const q = queue.find(x => x.qid === item.qid);
        if (q) Object.assign(q, { status: "failed", error: e.message });
        await chrome.storage.local.set({ queue });
      });
      await recordPosted(item.tweetId, { state: "failed", error: e.message, at: Date.now() });
      notify("LinkedIn post failed", e.message);
    } finally {
      release(item.tweetId);
    }
  } finally {
    ticking = false;
  }
}

function ensureAlarm() {
  chrome.alarms.get("xli-tick", a => {
    if (!a) chrome.alarms.create("xli-tick", { periodInMinutes: 1 });
  });
}
chrome.alarms.onAlarm.addListener(a => a.name === "xli-tick" && recoverStuck().then(processQueue, processQueue));
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  recoverStuck().then(processQueue, processQueue);
});
ensureAlarm();

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

// ---------- hook check (the "ChatGPT test") ----------
async function callClaude(s, system, user, maxTokens = 1200) {
  let model = s.anthropicModel;
  if (!model) {
    model = await pickModel(s.anthropicKey);
    await chrome.storage.local.set({ anthropicModel: model });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Claude error: " + (json.error?.message || res.status));
  return json.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
}

async function hookCheckWithClaude(text, s) {
  const system =
    "You review LinkedIn post drafts against a creator playbook. LinkedIn now cuts reach on 'AI slop': polished posts with no substance. " +
    "Every post must answer: why should I get this from you and not from ChatGPT? It answers with lived experience (a real moment) or proof (a result, why you're the one saying it).\n" +
    "Judge the draft on:\n" +
    "1. lived_or_proof: does line 1 carry something ChatGPT can't give: something the author lived, or proof?\n" +
    "2. specific: does it say who it was for and what the outcome was?\n" +
    "3. hook: do the first two lines work before 'see more'? Line 1 = the promise, line 2 = a second reason to keep reading.\n" +
    "4. chatgpt: if you asked ChatGPT the question this post answers, would you get basically the same thing? pass = no, it's clearly the author's own.\n" +
    "Then write 3 alternative first-two-line openers using ONLY facts already in the draft (never invent numbers, clients or events). " +
    "Mix these styles: Proof ('I've [result]. These are the [things] I used'), A moment ('Yesterday I was talking with a [type of client] who wanted to [goal].'), " +
    "How-to ('How we [outcome] for a [type of company], step by step.'), Contrast ('I [low point]. Last month I [result].'). Skip a style if the draft has no facts for it. " +
    "Plain words, casual and direct, no em dashes. Each opener is two lines separated by a newline.\n" +
    'Reply with ONLY JSON: {"checks":{"lived_or_proof":{"pass":true,"note":"..."},"specific":{"pass":true,"note":"..."},"hook":{"pass":true,"note":"..."},"chatgpt":{"pass":true,"note":"..."}},"openers":["line1\\nline2","...","..."],"summary":"one short sentence"}. Notes under 15 words.';
  const out = await callClaude(s, system, text);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Hook check came back in an odd format, try again.");
  return JSON.parse(m[0]);
}

// ---------- rhythm (posts per week, 12-week run) ----------
const WEEK = 7 * 864e5;
function mondayOf(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

async function rhythmStats() {
  const s = await getSettings();
  const { history = [], queue = [] } = await chrome.storage.local.get(["history", "queue"]);
  const posted = history.filter(h => h.ok).map(h => h.at);
  const target = Math.max(1, +s.postsPerWeek || 3);
  const now = Date.now();
  const thisWeek = mondayOf(now);
  const countIn = (a, b) => posted.filter(t => t >= a && t < b).length;
  const queuedIn = (a, b) => queue.filter(q => q.status !== "failed" && q.at >= a && q.at < b).length;

  // streak: consecutive weeks hitting the target, counting back from last week
  // (this week counts too once it's hit)
  let streak = countIn(thisWeek, thisWeek + WEEK) >= target ? 1 : 0;
  for (let w = thisWeek - WEEK; w > thisWeek - 104 * WEEK; w -= WEEK) {
    if (countIn(w, w + WEEK) >= target) streak++;
    else break;
  }

  let weeks = [];
  let weekIndex = null;
  if (s.runStart) {
    for (let i = 0; i < 12; i++) {
      const a = s.runStart + i * WEEK;
      const b = a + WEEK;
      const count = countIn(a, b);
      const state = a > now ? "future" : b > now ? "current" : count >= target ? "met" : "missed";
      if (state === "current") weekIndex = i + 1;
      weeks.push({ start: a, count, queued: queuedIn(a, b), state });
    }
    if (weekIndex === null && now >= s.runStart + 12 * WEEK) weekIndex = 13; // run finished
  }

  const upcoming = queue.filter(q => q.status === "scheduled").map(q => q.at).sort((a, b) => a - b);
  return {
    target,
    thisWeek: { posted: countIn(thisWeek, thisWeek + WEEK), queued: queuedIn(thisWeek, thisWeek + WEEK), start: thisWeek },
    nextWeekQueued: queuedIn(thisWeek + WEEK, thisWeek + 2 * WEEK),
    streak,
    runStart: s.runStart,
    weekIndex,
    weeks,
    queueUntil: upcoming.length ? upcoming[upcoming.length - 1] : null
  };
}

// ---------- message router ----------
const handlers = {
  async getSettings() {
    const s = await getSettings();
    const auth = await getAuth();
    return {
      settings: s,
      connected: !!auth && Date.now() < auth.expiresAt,
      name: auth?.name,
      expiresAt: auth?.expiresAt,
      redirectUri: chrome.identity.getRedirectURL()
    };
  },
  async connect() {
    return connectLinkedIn();
  },
  async disconnect() {
    await chrome.storage.local.remove("auth");
    return { ok: true };
  },
  async listModels({ key }) {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || "Couldn't load models");
    return json.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
  },
  // Called by the content script after an X post is confirmed sent.
  async prepare({ text, rewrite = true }) {
    const s = await getSettings();
    let linkedinText = text;
    let rewriteError = null;
    if (s.rewriteEnabled && rewrite) {
      try {
        linkedinText = await rewriteWithClaude(text, s);
      } catch (e) {
        rewriteError = e.message; // fall back to the original text
      }
    }
    return { linkedinText, rewriteError, mode: s.mode, countdownSeconds: s.countdownSeconds };
  },
  async publish({ text, images, xText, tweetId, visual, cardData }) {
    const { liStatus } = await getStore();
    const prev = tweetId && liStatus[tweetId];
    if (prev?.state === "posted") throw new Error("Already on LinkedIn. Open the dashboard if you want to post it again.");
    if (prev?.state === "posting" && Date.now() - (prev.at || 0) < 10 * 60e3)
      throw new Error("The last try was cut off, so it may already be on LinkedIn. Check your LinkedIn first, then post it from the dashboard if it's not there.");
    if (!claim(tweetId)) throw new Error("This post is already being sent to LinkedIn.");
    await recordPosted(tweetId, { state: "posting", at: Date.now() });
    try {
      const result = await publishToLinkedIn({ text, images, visual, cardData });
      await addHistory({ ok: true, xText, text, url: result.url, imageCount: result.imageCount, visual: result.visual });
      await recordPosted(tweetId, { state: "posted", url: result.url, at: Date.now(), text, images: (images || []).filter(x => typeof x === "string").slice(0, 4), visual: result.visual });
      if (tweetId)
        await withLock(async () => {
          const { queue } = await getStore();
          await chrome.storage.local.set({ queue: queue.filter(q => q.tweetId !== tweetId) });
        });
      return result;
    } catch (e) {
      await addHistory({ ok: false, xText, text, error: e.message });
      throw e;
    } finally {
      release(tweetId);
    }
  },
  async skipped({ xText }) {
    await addHistory({ ok: false, skipped: true, xText });
    return { ok: true };
  },
  async openOptions() {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  },

  // ----- old posts -----
  async setHandle({ handle }) {
    const { myHandle } = await chrome.storage.local.get("myHandle");
    if (handle && handle !== myHandle) await chrome.storage.local.set({ myHandle: handle });
    return { ok: true };
  },
  async savePosts({ posts }) {
    return withLock(async () => {
      const { xposts = {} } = await chrome.storage.local.get("xposts");
      let added = 0;
      for (const p of posts) {
        if (!p || !p.id) continue;
        if (!xposts[p.id]) added++;
        const prev = xposts[p.id] || {};
        if (p.src === "dom" && prev.id && prev.src !== "dom") {
          // page-scraped copy is less complete (no thread links, long posts cut off): only refresh counts
          Object.assign(prev, { likes: Math.max(prev.likes || 0, p.likes), views: Math.max(prev.views || 0, p.views) });
          continue;
        }
        xposts[p.id] = { ...prev, ...p, views: Math.max(prev.views || 0, p.views || 0) };
      }
      await chrome.storage.local.set({ xposts });
      return { added, total: Object.keys(xposts).length };
    });
  },
  async getDashboard() {
    const s = await getSettings();
    const auth = await getAuth();
    const { xposts, liStatus, queue } = await getStore();
    const { xProfile = {} } = await chrome.storage.local.get("xProfile");
    return {
      posts: Object.values(xposts),
      liStatus,
      queue,
      settings: s,
      connected: !!auth && Date.now() < auth.expiresAt,
      li: auth ? { name: auth.name || "", picture: auth.picture || "", expiresAt: auth.expiresAt } : null,
      xProfile
    };
  },
  async startImport() {
    const { myHandle } = await getSettings();
    const url = myHandle ? `https://x.com/${myHandle}#xli-import` : "https://x.com/home";
    chrome.tabs.create({ url });
    return { needsHandle: !myHandle };
  },
  async openDashboard() {
    openDashboard();
    return { ok: true };
  },
  async importFinished({ added }) {
    notify("X import finished", `${added} new posts saved. Open the dashboard to pick what goes to LinkedIn.`);
    return { ok: true };
  },
  async rewrite({ text }) {
    const s = await getSettings();
    return { text: await rewriteWithClaude(text, { ...s, anthropicKey: s.anthropicKey }) };
  },
  async postNow({ tweetId, text, images, visual, cardData }) {
    if (!claim(tweetId)) throw new Error("This post is already being sent to LinkedIn.");
    await recordPosted(tweetId, { state: "posting", at: Date.now() });
    await withLock(async () => {
      const { queue } = await getStore();
      const q = queue.find(x => x.tweetId === tweetId);
      if (q) { Object.assign(q, { status: "posting", postingAt: Date.now(), error: undefined }); await chrome.storage.local.set({ queue }); }
    });
    try {
      const r = await publishToLinkedIn({ text, images, visual, cardData });
      await recordPosted(tweetId, { state: "posted", url: r.url, at: Date.now(), text, images: (images || []).filter(x => typeof x === "string").slice(0, 4), visual: r.visual });
      await addHistory({ ok: true, xText: text, text, url: r.url, imageCount: r.imageCount, visual: r.visual });
      // if it was queued, drop it from the queue
      await withLock(async () => {
        const { queue } = await getStore();
        await chrome.storage.local.set({ queue: queue.filter(q => q.tweetId !== tweetId) });
      });
      return r;
    } catch (e) {
      await recordPosted(tweetId, { state: "failed", error: e.message, at: Date.now() });
      await withLock(async () => {
        const { queue } = await getStore();
        const q = queue.find(x => x.tweetId === tweetId && x.status === "posting");
        if (q) { Object.assign(q, { status: "failed", error: e.message }); await chrome.storage.local.set({ queue }); }
      });
      throw e;
    } finally {
      release(tweetId);
    }
  },
  // a post seen on x.com is only auto-posted if X itself confirms it: a real post, by you, with this text.
  // Anything we can't confirm (a script on the page faking one, a protected account, X being slow) waits for your click.
  async verifyTweet({ id, text, handle }) {
    const s = await getSettings();
    const me = String(s.myHandle || handle || "").toLowerCase();
    if (!/^\d{5,25}$/.test(String(id || "")) || !me) return { ok: false };
    if (s.myHandle && handle && String(handle).toLowerCase() !== me) return { ok: false }; // signed in as someone else
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
    const norm = t => String(t || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    // a brand-new post can take a few seconds to show up at X's public endpoint
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`, { credentials: "omit", cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          const author = String(j?.user?.screen_name || "").toLowerCase();
          const full = j?.note_tweet?.note_tweet_results?.result?.text || j?.text;
          const same = norm(full) === norm(text) || (norm(j?.text).length >= 270 && norm(text).startsWith(norm(j.text).replace(/…$/, "")));
          if (author !== me || !norm(text) || !same) return { ok: false };
          const images = (j.mediaDetails || []).filter(m => m.type === "photo" && /^https:\/\/pbs\.twimg\.com\//.test(m.media_url_https || "")).map(m => m.media_url_https);
          return { ok: true, images };
        }
      } catch {}
      await new Promise(res => setTimeout(res, 2500));
    }
    return { ok: false };
  },
  // items: [{tweetId, text, images, at?}] ; items without `at` get the next free slots
  async enqueue({ items }) {
    const long = (items || []).find(i => String(i.text || "").length > 3000);
    if (long) throw new Error(`That post is ${String(long.text).length.toLocaleString()} characters. LinkedIn allows 3,000: trim it in the editor first.`);
    return withLock(async () => {
      const s = await getSettings();
      const { queue } = await getStore();
      const ids = new Set(items.map(i => i.tweetId));
      const rest = queue.filter(q => !ids.has(q.tweetId)); // re-queueing replaces
      const needSlots = items.filter(i => !i.at).length;
      const slots = needSlots ? nextFreeSlots(needSlots, rest, s) : [];
      const added = items.map(i => ({
        qid: crypto.randomUUID(),
        tweetId: i.tweetId,
        text: i.text,
        images: i.images || [],
        visual: i.visual || "images",
        cardData: i.cardData || null,
        at: i.at || slots.shift(),
        queuedAt: Date.now(),
        status: "scheduled"
      }));
      await chrome.storage.local.set({ queue: [...rest, ...added].sort((a, b) => a.at - b.at) });
      return { added };
    });
  },
  async updateQueueItem({ qid, patch }) {
    return withLock(async () => {
      const { queue } = await getStore();
      const q = queue.find(x => x.qid === qid);
      if (!q) throw new Error("Queue item not found");
      if (q.status === "posting" && inflight.has(q.tweetId)) throw new Error("It's posting right now. Try again in a moment.");
      if (patch.at && patch.at < Date.now() + 60_000) {
        // a time that's already passed (an undo, an old date) goes to the next open slot instead of posting right away
        const [next] = XLISlots.upcoming(await getSettings(), queue.filter(x => x.qid !== qid), 1);
        if (next) patch = { ...patch, at: next.at };
      }
      Object.assign(q, patch);
      if (patch.at) Object.assign(q, { status: "scheduled", error: undefined });
      await chrome.storage.local.set({ queue: queue.sort((a, b) => a.at - b.at) });
      return q;
    });
  },
  async removeQueueItem({ qid }) {
    return withLock(async () => {
      const { queue } = await getStore();
      await chrome.storage.local.set({ queue: queue.filter(q => q.qid !== qid) });
      return { ok: true };
    });
  },
  // drag one queued post onto another: they trade times
  async swapQueueItems({ a, b }) {
    return withLock(async () => {
      const { queue } = await getStore();
      const x = queue.find(q => q.qid === a);
      const y = queue.find(q => q.qid === b);
      if (!x || !y) throw new Error("Queue item not found");
      if (x.status === "posting" || y.status === "posting") throw new Error("One of these is posting right now. Try again in a moment.");
      [x.at, y.at] = [y.at, x.at];
      for (const q of [x, y]) Object.assign(q, { status: "scheduled", error: undefined });
      await chrome.storage.local.set({ queue: queue.sort((m, n) => m.at - n.at) });
      return { ok: true };
    });
  },
  // move a queued post to the next open slot after its current time
  async bumpQueueItem({ qid }) {
    return withLock(async () => {
      const s = await getSettings();
      const { queue } = await getStore();
      const q = queue.find(x => x.qid === qid);
      if (!q) throw new Error("Queue item not found");
      if (q.status === "posting") throw new Error("It's posting right now. Try again in a moment.");
      const [next] = XLISlots.upcoming(s, queue.filter(x => x.qid !== qid), 1, Math.max(q.at, Date.now()) + 60000);
      if (!next) throw new Error("No open slot after this one.");
      Object.assign(q, { at: next.at, status: "scheduled", error: undefined });
      await chrome.storage.local.set({ queue: queue.sort((m, n) => m.at - n.at) });
      return q;
    });
  },
  async setSchedule({ slotTimes, slotDays, slotNatural }) {
    const patch = {};
    if (slotTimes !== undefined) {
      if (!XLISlots.valid(slotTimes)) throw new Error("Use times like 09:00-11:00, 20:00-23:00 or 9:17");
      patch.slotTimes = slotTimes;
    }
    if (slotDays !== undefined) patch.slotDays = slotDays.map(Number).filter(d => d >= 0 && d <= 6);
    if (slotNatural !== undefined) patch.slotNatural = !!slotNatural;
    const s = { ...(await getSettings()), ...patch };
    patch.postsPerWeek = Math.max(1, XLISlots.perWeek(s)); // the weekly goal follows the schedule
    await chrome.storage.local.set(patch);
    return { ...s, ...patch };
  },
  async markPosted({ tweetId, posted }) {
    return recLock(async () => {
      const { liStatus = {} } = await chrome.storage.local.get("liStatus");
      if (posted) liStatus[tweetId] = { state: "posted", at: Date.now(), manual: true };
      else delete liStatus[tweetId];
      await chrome.storage.local.set({ liStatus });
      return { ok: true };
    });
  },
  // For the "in" button on your posts: stored copy (full text), thread parts, status
  async postBundle({ id }) {
    const { xposts, liStatus, queue } = await getStore();
    const post = xposts[id] || null;
    const parts = [];
    if (post) {
      parts.push(post);
      const childOf = new Map();
      for (const p of Object.values(xposts)) {
        if (p.kind !== "thread" || !p.parentId) continue;
        const prev = childOf.get(p.parentId);
        if (!prev || p.createdAt < prev.createdAt) childOf.set(p.parentId, p);
      }
      let cur = post;
      const seen = new Set([post.id]);
      while (childOf.has(cur.id) && parts.length < 25) {
        cur = childOf.get(cur.id);
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        parts.push(cur);
      }
    }
    return { post, parts, status: liStatus[id] || null, queued: queue.find(q => q.tweetId === id) || null };
  },
  async statusFor({ ids }) {
    const { liStatus, queue } = await getStore();
    const out = {};
    for (const id of ids) {
      const q = queue.find(x => x.tweetId === id);
      if (q) out[id] = { state: "scheduled", at: q.at };
      else if (liStatus[id]?.state === "posted") out[id] = { state: "posted", url: liStatus[id].url };
    }
    return out;
  },
  async renderCard({ cardData }) {
    return { dataUrl: await XLICard.blobToDataUrl(await renderCard(cardData)) };
  },
  async setProfile({ profile }) {
    const { xProfile = {} } = await chrome.storage.local.get("xProfile");
    const next = { ...xProfile, ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined && v !== "")) };
    if (JSON.stringify(next) !== JSON.stringify(xProfile)) await chrome.storage.local.set({ xProfile: next });
    return next;
  },
  async hookCheck({ text }) {
    const s = await getSettings();
    if (!s.anthropicKey) throw new Error("Add an Anthropic API key in Settings for the AI hook check.");
    return hookCheckWithClaude(text, s);
  },
  async rhythm() {
    return rhythmStats();
  },
  async startRun() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    await chrome.storage.local.set({ runStart: d.getTime() });
    return rhythmStats();
  },
  // you marked a post as work or personal (or cleared it)
  async setFit({ id, label }) {
    return withLock(async () => {
      const { xposts = {} } = await chrome.storage.local.get("xposts");
      if (!xposts[id]) return { ok: false };
      if (label) xposts[id].fitOverride = label;
      else delete xposts[id].fitOverride;
      await chrome.storage.local.set({ xposts });
      return { ok: true };
    });
  },
  // Claude screens a batch of posts: work vs personal for a professional LinkedIn
  async screenPosts({ ids }) {
    const s = await getSettings();
    if (!s.anthropicKey || !s.screenWithClaude) return { screened: 0 };
    const { xposts = {} } = await chrome.storage.local.get("xposts");
    const batch = ids.map(id => xposts[id]).filter(p => p && !p.fitOverride && !(p.fit && p.fit.by === "claude")).slice(0, 30);
    if (!batch.length) return { screened: 0 };
    const system =
      "You decide which X posts belong on the author's professional LinkedIn. " +
      (s.topics ? `The author posts on LinkedIn about: ${s.topics}. ` : "The author is a founder and designer running a design studio. ") +
      "work = about their work, business, craft, lessons, results, tools, clients, building in public. " +
      "personal = daily life, weather, scenery, family, cars, health, jokes, greetings, replies aimed at a friend, anything that needs X context. " +
      "unclear = could go either way. Score 0-100 for LinkedIn fit. Keep why under 8 words. " +
      'Reply with ONLY JSON: {"results":[{"id":"...","label":"work|personal|unclear","score":0,"why":"..."}]}';
    const user = batch.map(p => `id: ${p.id}\n${(p.text || "").slice(0, 600)}${(p.images || []).length ? `\n[${p.images.length} photo(s)]` : ""}`).join("\n---\n");
    const out = await callClaude(s, system, user, 2000);
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Screening came back in an odd format.");
    const results = JSON.parse(m[0]).results || [];
    return withLock(async () => {
      const { xposts: fresh = {} } = await chrome.storage.local.get("xposts");
      let n = 0;
      for (const r of results) {
        if (!fresh[r.id] || !["work", "personal", "unclear"].includes(r.label)) continue;
        fresh[r.id].fit = { label: r.label, score: Math.max(0, Math.min(100, +r.score || 0)), why: String(r.why || "").slice(0, 60), by: "claude" };
        n++;
      }
      await chrome.storage.local.set({ xposts: fresh });
      return { screened: n };
    });
  },
  async runQueueNow() {
    await processQueue();
    return { ok: true };
  }
};

// x.com tabs (content scripts) run next to code we don't control, so they only get what they need,
// and never your LinkedIn secret or Claude key. The dashboard and settings pages get everything.
const FROM_X = new Set(["getSettings", "prepare", "publish", "skipped", "openOptions", "setHandle", "savePosts", "postBundle", "statusFor", "renderCard", "setProfile", "enqueue", "importFinished", "openDashboard", "verifyTweet"]);
const stripSecrets = data => (data && data.settings ? { ...data, settings: { ...data.settings, clientSecret: data.settings.clientSecret ? "set" : "", anthropicKey: data.settings.anthropicKey ? "set" : "" } } : data);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  const fromTab = !String(sender.url || "").startsWith(chrome.runtime.getURL("")); // anything that isn't our own page
  if (fromTab && !FROM_X.has(msg.type)) {
    sendResponse({ ok: false, error: "Not allowed from this page." });
    return false;
  }
  h(msg)
    .then(data => sendResponse({ ok: true, data: fromTab ? stripSecrets(data) : data }))
    .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // async response
});

chrome.action.onClicked.addListener(() => openDashboard());

// v1.6.1: the tweet card used to be picked automatically for posts without detected images.
// Switch already-queued items back to the post's own images (or text only), once.
async function migrateQueuedVisuals() {
  const { visualMigrated161, queue = [], xposts = {} } = await chrome.storage.local.get(["visualMigrated161", "queue", "xposts"]);
  if (visualMigrated161) return;
  let changed = 0;
  for (const q of queue) {
    if (q.visual !== "card" || q.status === "posting") continue;
    const p = xposts[q.tweetId];
    const imgs = (p?.images || []).map(u => (u.includes("name=") ? u.replace(/name=\w+/, "name=large") : u + (u.includes("?") ? "&" : "?") + "name=large"));
    q.visual = imgs.length ? "images" : "none";
    q.images = imgs.slice(0, 9);
    q.cardData = null;
    changed++;
  }
  await chrome.storage.local.set({ queue, visualMigrated161: true });
  return changed;
}
withLock(migrateQueuedVisuals).catch(() => {});

// schedule setup: a per-install salt, and v1.8 "09:00 Mon/Wed/Fri" becomes a morning window
async function migrateSchedule() {
  const st = await chrome.storage.local.get(["slotSeed", "slotTimes", "schedV"]);
  const patch = {};
  if (!st.slotSeed) patch.slotSeed = crypto.randomUUID().slice(0, 8);
  if (!st.schedV) {
    patch.schedV = 2;
    if (!st.slotTimes || st.slotTimes === "09:00") patch.slotTimes = XLISlots.DEFAULT_TIMES;
    const cur = await getSettings();
    patch.postsPerWeek = Math.max(1, XLISlots.perWeek({ ...cur, ...patch })); // the weekly goal now follows the schedule
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}
migrateSchedule().catch(() => {});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// Shared tweet parsing: used by harvest.js (live X GraphQL) and the dashboard (archive import).
(() => {
  const decode = s =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // Turn a legacy-style tweet object into our compact record.
  // `extra` can carry: noteText, noteEntities, author, views.
  function normalize(legacy, extra = {}) {
    if (!legacy || !(legacy.id_str || extra.id)) return null;
    const id = legacy.id_str || extra.id;
    const author = (extra.author || "").toLowerCase();

    let text;
    let urls;
    if (extra.noteText) {
      text = extra.noteText;
      urls = extra.noteEntities?.urls || [];
    } else {
      const full = legacy.full_text || legacy.text || "";
      const range = legacy.display_text_range;
      const cps = Array.from(full); // display_text_range is in code points
      text = range ? cps.slice(+range[0], +range[1]).join("") : full;
      urls = legacy.entities?.urls || [];
    }
    for (const u of urls) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    const mediaArr = legacy.extended_entities?.media || legacy.entities?.media || [];
    for (const m of mediaArr) if (m.url) text = text.split(m.url).join("");
    text = decode(text).trim();

    const images = mediaArr.filter(m => m.type === "photo").map(m => m.media_url_https || m.media_url).filter(Boolean);
    const hasVideo = mediaArr.some(m => m.type === "video" || m.type === "animated_gif");

    const isRetweet = !!legacy.retweeted_status_result || !!legacy.retweeted_status || /^RT @/.test(legacy.full_text || "");
    const replyTo = (legacy.in_reply_to_screen_name || "").toLowerCase();
    const parentId = legacy.in_reply_to_status_id_str || null;
    let kind = "post";
    if (isRetweet) kind = "retweet";
    else if (parentId && author && replyTo === author) kind = "thread"; // reply to yourself = thread part
    else if (parentId) kind = "reply";
    else if (legacy.is_quote_status) kind = "quote";

    return {
      id,
      author,
      text,
      createdAt: Date.parse(legacy.created_at) || 0,
      likes: +legacy.favorite_count || 0,
      reposts: +legacy.retweet_count || 0,
      replies: +legacy.reply_count || 0,
      views: +(extra.views || 0) || 0,
      images,
      hasVideo,
      kind,
      parentId,
      url: author ? `https://x.com/${author}/status/${id}` : `https://x.com/i/status/${id}`
    };
  }

  function fromResult(r) {
    if (!r) return null;
    if (r.__typename === "TweetWithVisibilityResults" && r.tweet) r = r.tweet;
    if (!r.legacy) return null;
    const u = r.core?.user_results?.result;
    const author = u?.core?.screen_name || u?.legacy?.screen_name || "";
    const note = r.note_tweet?.note_tweet_results?.result;
    const avatar = (u?.avatar?.image_url || u?.legacy?.profile_image_url_https || "").replace(/_normal\./, "_400x400.");
    const t = normalize(r.legacy, {
      id: r.rest_id,
      author,
      noteText: note?.text,
      noteEntities: note?.entity_set,
      views: r.views?.count
    });
    if (t) t.profile = { handle: author, name: u?.core?.name || u?.legacy?.name || "", avatar, verified: !!(u?.is_blue_verified || u?.legacy?.verified) };
    return t;
  }

  // Walk any GraphQL payload and pull out every Tweet object in it.
  function fromGraphQL(json) {
    const out = new Map();
    const seen = new Set();
    const walk = node => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if ((node.__typename === "Tweet" || node.__typename === "TweetWithVisibilityResults") && (node.legacy || node.tweet)) {
        const t = fromResult(node);
        if (t && !out.has(t.id)) out.set(t.id, t);
        // still walk: quoted tweets live inside, but they'll have another author
      }
      for (const k in node) walk(node[k]);
    };
    walk(json);
    return [...out.values()];
  }

  // X data archive: data/tweets.js ("window.YTD.tweets.part0 = [...]")
  function fromArchive(fileText, handle) {
    const json = JSON.parse(fileText.slice(fileText.indexOf("[")));
    return json
      .map(row => normalize(row.tweet || row, { author: handle }))
      .filter(Boolean);
  }

  // Which visual to attach on LinkedIn, given the setting and whether the post has photos
  function visualFor(mode, hasImages) {
    if (mode === "none") return "none";
    if (mode === "card") return "card";
    if (mode === "images") return hasImages ? "images" : "none";
    return hasImages ? "images" : "none"; // auto: the post as it is, card only when chosen
  }
  // What goes on the tweet card: the original post as it looks on X
  function cardDataFor(post, withImage = true) {
    if (!post) return null;
    return { text: post.text || "", createdAt: post.createdAt || Date.now(), image: withImage && post.images && post.images[0] ? post.images[0] : null };
  }

  // ---------- LinkedIn fit: is this post work/professional, or personal? ----------
  const WORK = [
    "design", "designer", "brand", "branding", "product", "ux", "ui", "client", "clients", "studio", "agency", "startup", "founder", "saas",
    "revenue", "mrr", "arr", "pricing", "price", "launch", "launched", "ship", "shipped", "shipping", "build", "building", "built", "hire", "hiring",
    "team", "framer", "figma", "landing page", "website", "onboarding", "conversion", "growth", "marketing", "sales", "leads", "customers", "users",
    "business", "subscription", "project", "portfolio", "case study", "lesson", "learned", "mistake", "tips", "how to", "playbook", "strategy",
    "ai", "claude", "gpt", "tool", "tools", "workflow", "process", "yc", "investor", "raise", "prototype", "dashboard", "app", "feature", "redesign",
    "copy", "deck", "pitch", "contract", "invoice", "retainer", "freelance", "freelancer", "career", "job", "work", "working", "meeting", "async"
  ];
  const PERSONAL = [
    "good morning", "gm", "good night", "gn", "weekend", "saturday", "sunday", "car", "drive", "driving", "pain", "sick", "heaven", "views", "view from",
    "sunset", "sunrise", "home", "family", "kid", "kids", "toddler", "baby", "wife", "husband", "dinner", "lunch", "breakfast", "coffee", "gym",
    "vacation", "holiday", "birthday", "weather", "fog", "foggy", "rain", "snow", "beach", "lake", "hike", "hiking", "who's this", "who’s this",
    "lol", "lmao", "haha", "vibes", "mood", "shadows", "nature", "sky", "trip", "travel", "dog", "cat", "movie", "game", "football", "cricket"
  ];
  const hits = (text, words) => {
    const t = " " + text.toLowerCase().replace(/[^\p{L}\p{N}$%'’ ]+/gu, " ") + " ";
    return words.filter(w => t.includes(" " + w + " ") || (w.length > 4 && t.includes(" " + w))).length;
  };

  // extra: comma-separated topics you post about on LinkedIn (from Settings) count as work signals
  function linkedinFit(post, topics = []) {
    if (!post) return { score: 0, label: "personal", why: "empty" };
    if (post.fitOverride) return { score: post.fitOverride === "work" ? 100 : 0, label: post.fitOverride, why: "you marked it", manual: true };
    if (post.fit && post.fit.by === "claude") return post.fit;
    const text = (post.text || "").trim();
    const len = text.replace(/https?:\/\/\S+/g, "").trim().length;
    let s = 50;
    const why = [];
    const w = hits(text, WORK.concat(topics.map(t => t.trim().toLowerCase()).filter(Boolean)));
    const p = hits(text, PERSONAL);
    if (w) (s += Math.min(40, w * 12)), why.push("work topic");
    if (p) (s -= Math.min(45, p * 15)), why.push("personal topic");
    if (len < 40) (s -= w ? 10 : 20), why.push("very short");
    else if (len < 80) s -= w ? 0 : 10;
    else if (len > 160) s += 10;
    if (len > 280) s += 5;
    if (/\d/.test(text) && /(\d+%|\$\d|\d+x\b|\d{2,})/i.test(text)) (s += 8), why.push("has numbers");
    if (/@\w+/.test(text) && len < 120) (s -= 10), why.push("aimed at someone");
    if (/\?\s*$/.test(text) && len < 60) s -= 10;
    if ((post.images || []).length && len < 60 && !w) (s -= 10), why.push("photo caption");
    if (post.kind === "reply") s -= 25;
    s = Math.max(0, Math.min(100, Math.round(s)));
    return { score: s, label: s >= 60 ? "work" : s <= 38 ? "personal" : "unclear", why: why.slice(0, 2).join(", ") || "neutral" };
  }

  globalThis.XLIParse = { normalize, fromResult, fromGraphQL, fromArchive, visualFor, cardDataFor, linkedinFit };
})();

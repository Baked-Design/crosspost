// Runs in X's own page context. X loads timelines via GraphQL; we read a copy of
// those responses (never modify them) and hand them to harvest.js.
(() => {
  if (window.__xliInject) return;
  window.__xliInject = true;

  const WANT = /\/graphql\/[^/]+\/(UserTweets|UserTweetsAndReplies|UserMedia|UserHighlightsTweets|TweetDetail|TweetResultByRestId|HomeTimeline|HomeLatestTimeline|SearchTimeline|CreateTweet|CreateNoteTweet)/;

  const emit = (url, text) => {
    try {
      window.postMessage({ __xli: "gql", op: (url.match(WANT) || [])[1], json: JSON.parse(text) }, location.origin);
    } catch {}
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (WANT.test(url)) res.clone().text().then(t => emit(url, t)).catch(() => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (WANT.test(String(url))) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") emit(String(url), this.responseText);
            else if (this.responseType === "json") emit(String(url), JSON.stringify(this.response));
          } catch {}
        });
      }
    } catch {}
    return origOpen.call(this, method, url, ...rest);
  };
})();

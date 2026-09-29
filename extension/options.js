const $ = id => document.getElementById(id);
if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embed");
const FIELDS = [
  "clientId", "clientSecret", "mode", "countdownSeconds", "skipReplies", "skipQuotes",
  "includeImages", "visualMode", "cardTheme", "skipMarker", "topics", "hidePersonal", "screenWithClaude", "personalLive", "rewriteEnabled", "anthropicKey", "anthropicModel", "rewriteInstructions"
];

const send = msg =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res && res.ok ? resolve(res.data) : reject(new Error(res ? res.error : "No response"));
    })
  );

function flashSaved(text = "Saved") {
  const el = $("saved");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => el.classList.remove("show"), 1200);
}

function readField(id) {
  const el = $(id);
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return Math.max(3, Math.min(120, parseInt(el.value, 10) || 10));
  return el.value.trim();
}

function syncVisibility() {
  $("countdownWrap").hidden = $("mode").value !== "countdown";

}

function renderStatus({ connected, name, expiresAt }) {
  const days = expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 86400000)) : 0;
  $("statusDot").className = "dot" + (connected ? " on" : "");
  $("status").textContent = connected ? `Connected as ${name || "you"}` : expiresAt ? "Login expired" : "Not connected";
  $("statusSub").textContent = connected
    ? `Login renews in ${days} days. Reconnect any time.`
    : expiresAt
    ? "LinkedIn logins last 60 days. Reconnect to keep posting."
    : "Add your app details below, then connect";
  $("connect").textContent = connected ? "Reconnect" : "Connect LinkedIn";
  $("setup").open = !connected;
  $("disconnect").hidden = !connected;
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const ul = $("history");
  if (!history.length) return;
  ul.innerHTML = "";
  for (const h of history.slice(0, 15)) {
    const li = document.createElement("li");
    const when = new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const [cls, sym] = h.ok ? ["ok", "✓"] : h.skipped ? ["skip", "–"] : ["bad", "!"];
    li.innerHTML = `<span class="s ${cls}">${sym}</span><div><div class="x"></div><div class="t e"></div></div><div class="t">${when}</div>`;
    li.querySelector(".x").textContent = h.text || h.xText || "";
    li.querySelector(".e").textContent = h.error || (h.skipped ? "Skipped" : "");
    if (h.url) {
      const a = document.createElement("a");
      a.href = h.url; a.target = "_blank"; a.textContent = "View";
      li.querySelector(".t:last-child").append(" · ", a);
    }
    ul.appendChild(li);
  }
}

async function init() {
  const data = await send({ type: "getSettings" });
  const s = data.settings;
  $("redirect").textContent = data.redirectUri;

  if (s.anthropicModel) {
    const o = document.createElement("option");
    o.value = o.textContent = s.anthropicModel;
    $("anthropicModel").appendChild(o);
  }
  for (const id of FIELDS) {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!s[id];
    else el.value = s[id] ?? "";
  }
  syncVisibility();
  renderStatus(data);
  renderHistory();

  for (const id of FIELDS) {
    const el = $(id);
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", async () => {
      await chrome.storage.local.set({ [id]: readField(id) });
      syncVisibility();
      flashSaved();
    });
  }
}

$("redirectBox").onclick = async () => {
  await navigator.clipboard.writeText($("redirect").textContent);
  flashSaved("Redirect URL copied");
};

$("connect").onclick = async () => {
  const msg = $("connectMsg");
  const show = (cls, text) => {
    msg.innerHTML = `<div class="msg ${cls}"></div>`;
    msg.firstChild.textContent = text;
  };
  show("info", "Opening LinkedIn…");
  try {
    await send({ type: "connect" });
    show("ok", "Connected. Post something on X to try it.");
    renderStatus(await send({ type: "getSettings" }));
  } catch (e) {
    show("bad", e.message);
  }
};

$("disconnect").onclick = async () => {
  await send({ type: "disconnect" });
  renderStatus(await send({ type: "getSettings" }));
};

$("loadModels").onclick = async () => {
  const key = $("anthropicKey").value.trim();
  if (!key) return flashSaved("Add your Anthropic API key first");
  const btn = $("loadModels");
  btn.textContent = "Loading…";
  try {
    const models = await send({ type: "listModels", key });
    const sel = $("anthropicModel");
    const current = sel.value;
    sel.innerHTML = '<option value="">Auto (latest Sonnet)</option>';
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.name + " (" + m.id + ")";
      sel.appendChild(o);
    }
    sel.value = current;
    btn.textContent = "Loaded";
  } catch (e) {
    btn.textContent = "Load models";
    flashSaved(e.message);
  }
};

$("playbook").onclick = async () => {
  // remove the saved value so the built-in playbook default applies
  await chrome.storage.local.remove("rewriteInstructions");
  const data = await send({ type: "getSettings" });
  $("rewriteInstructions").value = data.settings.rewriteInstructions;
  flashSaved("Playbook instructions restored");
};

chrome.storage.onChanged.addListener(changes => {
  if (changes.history) renderHistory();
});

init();

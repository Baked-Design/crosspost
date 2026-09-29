// Renders a clean "tweet screenshot" style image for LinkedIn (1080 x 1350, 4:5 portrait,
// fills the mobile feed). Works in the service worker via OffscreenCanvas.
(() => {
  const W = 1080;
  const H = 1350;
  const PAD = 96;
  const FONT = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  let fontsReady = null;
  function ensureFonts() {
    if (fontsReady) return fontsReady;
    fontsReady = (async () => {
      try {
        if (!self.fonts || typeof FontFace === "undefined") return;
        for (const w of [400, 500, 700]) {
          const f = new FontFace("Inter", `url(${chrome.runtime.getURL(`fonts/inter-${w}.woff2`)})`, { weight: String(w) });
          await f.load();
          self.fonts.add(f);
        }
      } catch {}
    })();
    return fontsReady;
  }

  const THEMES = {
    light: { bg: "#ffffff", text: "#0f1419", muted: "#536471", line: "#eff3f4", badge: "#1d9bf0" },
    dark: { bg: "#000000", text: "#e7e9ea", muted: "#71767b", line: "#2f3336", badge: "#1d9bf0" }
  };

  async function loadBitmap(url) {
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await createImageBitmap(await res.blob());
    } catch {
      return null;
    }
  }

  // Word wrap that keeps your own line breaks and splits over-long words.
  function wrap(ctx, text, maxW) {
    const lines = [];
    for (const para of text.split("\n")) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        const test = line + word;
        if (ctx.measureText(test).width <= maxW) {
          line = test;
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = word.trimStart();
        // a single word wider than the line: hard-split it
        while (ctx.measureText(line).width > maxW) {
          let i = line.length;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
          lines.push(line.slice(0, i));
          line = line.slice(i);
        }
      }
      if (line.trim()) lines.push(line.trimEnd());
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBadge(ctx, x, y, s, color) {
    // X-style verified badge: scalloped circle with a check
    ctx.save();
    ctx.translate(x + s / 2, y + s / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    const n = 8;
    for (let i = 0; i <= n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2;
      const r = i % 2 ? s * 0.44 : s * 0.5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = s * 0.11;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, 0);
    ctx.lineTo(-s * 0.05, s * 0.15);
    ctx.lineTo(s * 0.22, -s * 0.15);
    ctx.stroke();
    ctx.restore();
  }

  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${t} · ${day}`;
  }

  async function renderTweetCard(data) {
    await ensureFonts();
    const th = THEMES[data.theme] || THEMES.light;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);

    const [avatar, photo] = await Promise.all([loadBitmap(data.avatar), loadBitmap(data.image)]);
    const text = (data.text || "").trim();
    const innerW = W - PAD * 2;

    // Layout sizes
    const AV = 120;
    const headerH = AV;
    const gap1 = 52;
    const gap2 = 44;
    const footerH = data.createdAt ? 40 : 0;
    const gap3 = footerH ? 44 : 0;

    // Photo gets up to 45% of the card if there's text, more if there isn't
    let photoH = 0;
    let photoW = innerW;
    if (photo) {
      const natural = innerW * (photo.height / photo.width);
      const cap = text ? H * 0.42 : H - PAD * 2 - headerH - gap1 - footerH - gap3;
      photoH = Math.min(natural, cap);
    }
    const photoGap = photo && text ? 40 : 0;

    const availText = H - PAD * 2 - headerH - gap1 - photoH - photoGap - gap3 - footerH;

    // Biggest font that fits
    let size = 76;
    let lines = [];
    let lh = 0;
    for (; size >= 30; size -= 2) {
      ctx.font = `400 ${size}px ${FONT}`;
      lines = text ? wrap(ctx, text, innerW) : [];
      lh = Math.round(size * 1.34);
      if (lines.length * lh <= availText) break;
    }
    if (size < 30) {
      size = 30;
      ctx.font = `400 ${size}px ${FONT}`;
      lh = Math.round(size * 1.34);
      const max = Math.max(1, Math.floor(availText / lh));
      lines = wrap(ctx, text, innerW).slice(0, max);
      let last = lines[max - 1] || "";
      while (last && ctx.measureText(last + "…").width > innerW) last = last.slice(0, -1);
      lines[max - 1] = last.trimEnd() + "…";
    }
    const textH = lines.length * lh;

    const total = headerH + gap1 + textH + photoGap + photoH + gap3 + footerH;
    let y = Math.max(PAD, Math.round((H - total) / 2));

    // Header: avatar, name, badge, handle
    const x = PAD;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + AV / 2, y + AV / 2, AV / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (avatar) ctx.drawImage(avatar, x, y, AV, AV);
    else {
      ctx.fillStyle = th.line;
      ctx.fillRect(x, y, AV, AV);
    }
    ctx.restore();

    const nx = x + AV + 28;
    const name = data.name || data.handle || "";
    ctx.fillStyle = th.text;
    ctx.font = `700 46px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    let nameText = name;
    const nameMax = W - PAD - nx - (data.verified ? 60 : 0);
    while (nameText && ctx.measureText(nameText).width > nameMax) nameText = nameText.slice(0, -1);
    if (nameText !== name) nameText = nameText.trimEnd() + "…";
    ctx.fillText(nameText, nx, y + 52);
    if (data.verified) drawBadge(ctx, nx + ctx.measureText(nameText).width + 12, y + 14, 44, th.badge);
    ctx.fillStyle = th.muted;
    ctx.font = `400 38px ${FONT}`;
    if (data.handle) ctx.fillText("@" + data.handle, nx, y + 104);
    y += headerH + gap1;

    // Text
    ctx.fillStyle = th.text;
    ctx.font = `400 ${size}px ${FONT}`;
    ctx.textBaseline = "top";
    for (const line of lines) {
      ctx.fillText(line, x, y + (lh - size) / 2);
      y += lh;
    }

    // Photo (cover-cropped, rounded)
    if (photo) {
      y += photoGap;
      ctx.save();
      roundRect(ctx, x, y, photoW, photoH, 28);
      ctx.clip();
      const scale = Math.max(photoW / photo.width, photoH / photo.height);
      const dw = photo.width * scale;
      const dh = photo.height * scale;
      ctx.drawImage(photo, x + (photoW - dw) / 2, y + (photoH - dh) / 2, dw, dh);
      ctx.restore();
      ctx.strokeStyle = th.line;
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, photoW, photoH, 28);
      ctx.stroke();
      y += photoH;
    }

    // Footer date
    if (footerH) {
      y += gap3;
      ctx.fillStyle = th.muted;
      ctx.font = `400 34px ${FONT}`;
      ctx.textBaseline = "top";
      ctx.fillText(fmtDate(data.createdAt), x, y);
    }

    return canvas.convertToBlob({ type: "image/png" });
  }

  async function blobToDataUrl(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
  }

  globalThis.XLICard = { renderTweetCard, blobToDataUrl };
})();

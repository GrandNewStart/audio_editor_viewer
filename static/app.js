"use strict";

// ---------------------------------------------------------------- state
const S = {
  run: null,
  samples: [],
  shown: [],
  sel: null,          // selected id
  detail: null,
  tracks: [],         // {name, label, buffer, mono, el, canvas, base, change}
  maxDur: 1,
  active: 0,          // index into tracks
  seg: null,          // {track, a, b} highlighted rubric segment
  loadToken: 0,
};
const P = { ctx: null, node: null, playing: false, track: 0, offset: 0, startCtx: 0, pausedAt: 0, end: null };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined ? "—" : typeof v === "number" ? v.toFixed(d) : v);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem("ac." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ac." + k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- list
async function loadSamples() {
  const r = await fetch("/api/samples").then((r) => r.json());
  S.samples = r.samples;
  const [done, total] = r.progress;
  $("#run-info").textContent = `· ${total} samples` + (done < total ? ` · metrics ${done}/${total}…` : "");
  const mods = [...new Set(S.samples.map((s) => s.modality).filter(Boolean))].sort();
  const sel = $("#f-modality");
  if (sel.options.length === 1) for (const m of mods) sel.add(new Option(m, m));
  sel.value = store.get("modality", "");
  renderList();
  if (done < total) setTimeout(loadSamples, 1500);
}

function sortKey(s, how) {
  const m = s.metrics || {};
  switch (how) {
    case "ifr": return s.ifr;
    case "cr": return s.cr;
    case "lsd": return m.lsd_db;
    case "lsd-desc": return m.lsd_db == null ? null : -m.lsd_db;
    case "dur": return m.duration_delta == null ? null : -Math.abs(m.duration_delta);
    default: return null;
  }
}

function renderList() {
  const q = $("#q").value.trim().toLowerCase();
  const mod = $("#f-modality").value, flag = $("#f-flag").value, how = $("#sort").value;
  let xs = S.samples.filter((s) => {
    if (q && !(s.id.includes(q) || s.instruction.toLowerCase().includes(q))) return false;
    if (mod && s.modality !== mod) return false;
    if (flag === "nooutput") return !s.has_output;
    if (flag === "em0") return s.em === 0;
    if (flag === "em1") return s.em === 1;
    if (flag) return !!(s.metrics && s.metrics.flags.includes(flag));
    return true;
  });
  if (how !== "id") {
    xs = xs.slice().sort((a, b) => {
      const ka = sortKey(a, how), kb = sortKey(b, how);
      if (ka == null && kb == null) return a.id < b.id ? -1 : 1;
      if (ka == null) return 1;
      if (kb == null) return -1;
      return ka - kb;
    });
  }
  S.shown = xs;
  $("#list-count").textContent = `${xs.length} of ${S.samples.length}`;
  const ul = $("#list");
  const scroll = ul.parentElement.scrollTop;
  ul.innerHTML = xs.map((s) => {
    const chips = [];
    if (s.ifr != null) chips.push(scoreChip("IF", s.ifr));
    if (s.cr != null) chips.push(scoreChip("C", s.cr));
    if (s.em === 1) chips.push(`<span class="chip good">EM</span>`);
    if (!s.has_output) chips.push(`<span class="chip bad">no output</span>`);
    for (const f of s.metrics?.flags || []) chips.push(`<span class="chip warn">${f}</span>`);
    return `<li data-id="${s.id}" class="${s.id === S.sel ? "sel" : ""}">
      <div class="row1"><span class="mono muted">${s.id}</span><span class="small muted">${esc(s.modality)}</span></div>
      <div class="ins">${s.n_instructions > 1 ? `<span class="chip">${s.n_instructions} turns</span> ` : ""}${esc(s.instruction)}</div>
      <div class="meta-line">${chips.join("")}</div></li>`;
  }).join("");
  ul.parentElement.scrollTop = scroll;
}

function scoreChip(label, v) {
  const cls = v >= 0.999 ? "good" : v <= 0.001 ? "bad" : "";
  return `<span class="chip ${cls}">${label} ${v.toFixed(2)}</span>`;
}

// ---------------------------------------------------------------- detail
async function select(id) {
  if (!id) return;
  stop();
  S.sel = id;
  S.seg = null;
  history.replaceState(null, "", "#" + id);
  document.querySelectorAll("#list li").forEach((li) => li.classList.toggle("sel", li.dataset.id === id));
  document.querySelector(`#list li[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });

  const token = ++S.loadToken;
  $("#detail").innerHTML = `<p class="muted empty">Loading ${id}…</p>`;
  const d = await fetch("/api/sample/" + id).then((r) => r.json());
  if (token !== S.loadToken) return;
  S.detail = d;

  const specs = d.sources.map((s) => ({ name: s.name, label: s.name === "input1" ? "source (input1)" : s.name, url: s.exists ? s.url : null }));
  specs.push({ name: "output", label: "output", url: d.output_url });
  S.tracks = specs.map((s) => ({ ...s, buffer: null, mono: null }));
  S.active = S.tracks.length - 1;
  P.pausedAt = 0;
  renderDetail(d);

  ensureCtx();
  await Promise.all(S.tracks.map(async (t) => {
    if (!t.url) return;
    try {
      const ab = await fetch(t.url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
      const buf = await P.ctx.decodeAudioData(ab);
      if (token !== S.loadToken) return;
      t.buffer = buf;
      t.mono = mixdown(buf);
    } catch (e) {
      t.error = String(e);
    }
  }));
  if (token !== S.loadToken) return;
  S.maxDur = Math.max(0.1, ...S.tracks.map((t) => (t.buffer ? t.buffer.duration : 0)));
  renderAxis();
  renderTracks();
}

function renderDetail(d) {
  const m = d.metrics;
  const ops = (d.operations || []).map((o) => `<span class="chip">${esc(o.granularity)} · ${esc(o.operation)}</span>`).join("");
  const flags = (m?.flags || []).map((f) => `<span class="chip warn">${f}</span>`).join("");
  const scores = [
    d.ifr != null ? scoreChip("IFR", d.ifr) : "",
    d.cr != null ? scoreChip("CR", d.cr) : "",
    d.em != null ? `<span class="chip ${d.em ? "good" : ""}">EM ${d.em}</span>` : "",
  ].join("");

  $("#detail").innerHTML = `
    <div class="mono muted">${d.id} · ${esc(d.split)} · ${esc(d.modality)} · ${esc(d.complexity)}</div>
    <ol class="instructions">${d.instructions.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
    <div class="meta-line">${ops}${scores}${flags}</div>

    <div class="transport">
      <button id="btn-play">▶ Play</button>
      <span id="ab"></span>
      <span id="time" class="mono">0.00 s</span>
    </div>
    <div class="axis" id="axis"></div>
    <div id="tracks">${S.tracks.map((t, i) => `
      <div class="track" data-i="${i}">
        <div class="track-label"><span class="name">${esc(t.label)}</span><span class="info muted small"></span></div>
        <canvas class="main" height="180"></canvas>
        ${t.name === "output" ? `<canvas class="change" height="40" title="Per-frame spectral difference vs source (dB). Dashed line: 6 dB."></canvas>
          <div class="small muted">↑ where the output differs from the source (log-spectral distance per 10 ms, time-aligned from 0 s)${d.trace?.changed_spans?.length ? " · orange band: changed_spans from the trace" : ""}</div>` : ""}
      </div>`).join("")}
    </div>

    <h2>Metrics <span class="muted small">(source = input1, compared as mono 16 kHz)</span></h2>
    ${m ? metricsTable(m) : `<p class="muted">${esc(d.metrics_error || (d.has_output ? "source audio not found" : "no output for this sample"))}</p>`}

    ${d.rubrics.length ? `<h2>Rubrics</h2>${d.rubrics.map(rubricHTML).join("")}` : ""}
    ${d.trace ? traceHTML(d.trace) : ""}`;

  $("#ab").innerHTML = S.tracks.map((t, i) => `<button data-i="${i}" title="${i === S.tracks.length - 1 ? "B" : i === 0 ? "A" : ""}">${esc(t.name)}</button>`).join(" ");
  $("#ab").onclick = (e) => { const b = e.target.closest("button"); if (b) switchTo(+b.dataset.i); };
  $("#btn-play").onclick = toggle;
  document.querySelectorAll(".track canvas").forEach((c) => c.addEventListener("click", onTrackClick));
  document.querySelectorAll(".seg-chip").forEach((c) => c.addEventListener("click", onSegClick));
  updateAB();
}

function metricsTable(m) {
  const row = (label, a, b, d = 2, unit = "") => `<tr><td>${label}</td><td class="num">${fmt(a, d)}${a != null && unit ? unit : ""}</td><td class="num">${fmt(b, d)}${b != null && unit ? unit : ""}</td></tr>`;
  return `<table>
    <tr><th></th><th class="num">source</th><th class="num">output</th></tr>
    ${row("duration", m.src_duration, m.out_duration, 2, " s")}
    ${row("sample rate / channels", `${m.src_sr} / ${m.src_channels}`, `${m.out_sr} / ${m.out_channels}`)}
    ${row("RMS", m.src_rms_db, m.out_rms_db, 1, " dBFS")}
    ${row("peak", null, m.out_peak_db, 1, " dBFS")}
    ${row("clipped samples", null, m.out_clip_pct, 3, " %")}
  </table>
  <table style="margin-top:8px">
    <tr><th>comparison</th><th class="num">value</th><th>meaning</th></tr>
    <tr><td>Δ duration</td><td class="num">${fmt(m.duration_delta, 2)} s</td><td class="muted small">output − source</td></tr>
    <tr><td>Δ RMS</td><td class="num">${fmt(m.rms_delta_db, 1)} dB</td><td class="muted small">overall level change</td></tr>
    <tr><td>correlation</td><td class="num">${fmt(m.corr, 3)}</td><td class="muted small">waveform similarity over the overlap (1 = identical)</td></tr>
    <tr><td>log-spectral distance</td><td class="num">${fmt(m.lsd_db, 2)} dB</td><td class="muted small">mean spectral change (0 = unchanged)</td></tr>
    <tr><td>changed frames</td><td class="num">${fmt(m.changed_pct, 1)} %</td><td class="muted small">10 ms frames differing by &gt; 6 dB</td></tr>
  </table>`;
}

const SEG_RE = /<audio (\w+)(?:\[([\d.]+)s?\s*:\s*([\d.]+)s?\])?>/g;
function withSegChips(text) {
  let out = "", last = 0;
  for (const mt of text.matchAll(SEG_RE)) {
    out += esc(text.slice(last, mt.index));
    const [whole, name, a, b] = mt;
    out += `<span class="seg-chip" data-track="${esc(name)}" data-a="${a ?? ""}" data-b="${b ?? ""}" title="play this">▶ ${esc(whole.slice(7, -1))}</span>`;
    last = mt.index + whole.length;
  }
  return out + esc(text.slice(last));
}

function rubricHTML(r) {
  const verdict = r.score == null ? `<span class="chip">not judged</span>`
    : r.score >= 1 ? `<span class="chip good">✓ judge agreed</span>` : `<span class="chip bad">✗ judge disagreed</span>`;
  const votes = r.scores ? `<span class="muted small">votes ${r.scores.join(" ")}</span>` : "";
  const wrongPick = r.judge_choice && r.score === 0 ? `<div class="ans">judge picked: ${withSegChips(r.judge_choice)}</div>` : "";
  return `<div class="rubric">
    <div class="meta-line"><span class="chip">${esc(r.category)}</span>${verdict}${votes}</div>
    <div class="q">${withSegChips(r.question)}</div>
    <div class="ans">expected: <strong>${withSegChips(r.right_choice)}</strong></div>
    ${wrongPick}
    ${r.judge_reason ? `<details><summary class="muted">judge's reason</summary>${withSegChips(r.judge_reason)}</details>` : ""}
  </div>`;
}

function traceHTML(t) {
  const head = [
    t.error ? `<span class="chip bad">error: ${esc(t.error)}</span>` : "",
    t.fallback_used ? `<span class="chip warn">fallback: ${esc(JSON.stringify(t.fallback_used))}</span>` : "",
    t.budget_hit ? `<span class="chip warn">budget hit</span>` : "",
    t.wall_seconds != null ? `<span class="chip">${t.wall_seconds.toFixed(1)} s</span>` : "",
    t.changed_spans?.length ? `<span class="chip">changed_spans ${esc(JSON.stringify(t.changed_spans))}</span>` : "",
  ].join("");
  const steps = t.steps.map((s) => `<li class="${s.error ? "err" : s.changed_spans ? "edit" : ""}">
      <span class="tool">${s.step != null ? s.step + ". " : ""}${esc(s.tool)}</span> <span class="mono">${esc(s.args || "")}</span>
      ${s.error ? `<div class="res" style="color:var(--bad)">${esc(s.error)}</div>` : ""}
      ${s.changed_spans ? `<div class="res">changed ${esc(JSON.stringify(s.changed_spans))}</div>` : ""}
      ${s.note ? `<div class="res">${esc(s.note)}</div>` : ""}
      ${s.result ? `<div class="res mono">${esc(s.result)}</div>` : ""}
    </li>`).join("");
  return `<h2>Agent trace</h2><div class="meta-line">${head}</div>
    ${t.preserve ? `<div class="small muted">preserve: ${esc(t.preserve)}</div>` : ""}
    <details open><summary class="muted">${t.steps.length} steps</summary><ul class="steps">${steps}</ul></details>`;
}

// ---------------------------------------------------------------- drawing
function mixdown(buf) {
  const n = buf.length, out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += x[i];
  }
  if (buf.numberOfChannels > 1) for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
  return out;
}

function fft(re, im) {  // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const MAGMA = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
function cmap(v) {
  v = Math.min(1, Math.max(0, v)) * (MAGMA.length - 1);
  const i = Math.min(MAGMA.length - 2, Math.floor(v)), f = v - i, a = MAGMA[i], b = MAGMA[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const WAVE_H = 56;  // css px of the 180 px track used by the waveform; the rest is the spectrogram

function renderBase(t, canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(canvas.clientWidth * dpr)), H = Math.round(180 * dpr);
  canvas.width = W; canvas.height = H;
  const base = document.createElement("canvas");
  base.width = W; base.height = H;
  const g = base.getContext("2d");
  g.fillStyle = "#0b0b0d"; g.fillRect(0, 0, W, H);
  if (!t.mono) {
    g.fillStyle = "#888"; g.font = `${12 * dpr}px sans-serif`;
    g.fillText(t.url ? (t.error ? "could not load: " + t.error : "loading…") : "no audio", 10 * dpr, 20 * dpr);
    return base;
  }
  const sr = t.buffer.sampleRate, x = t.mono, cols = Math.min(W, Math.ceil(W * (t.buffer.duration / S.maxDur)));
  const wh = Math.round(WAVE_H * dpr), sh = H - wh;

  // waveform (min/max per column)
  g.fillStyle = "#c7d2e6";
  const per = x.length / cols, mid = wh / 2;
  for (let c = 0; c < cols; c++) {
    let lo = 1, hi = -1;
    const a = Math.floor(c * per), b = Math.min(x.length, Math.floor((c + 1) * per) + 1);
    for (let i = a; i < b; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi < lo) continue;
    g.fillRect(c, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
  g.fillStyle = "#333"; g.fillRect(0, wh - 1, W, 1);

  // spectrogram, log-frequency 40 Hz .. min(sr/2, 20 kHz), absolute dB scale so tracks compare
  const N = sr > 32000 ? 2048 : 1024, win = new Float32Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); wsum += win[i]; }
  const fmin = 40, fmax = Math.min(sr / 2, 20000);
  const rowLo = new Int32Array(sh), rowHi = new Int32Array(sh);
  for (let r = 0; r < sh; r++) {  // r = 0 is the top row
    const f0 = fmin * Math.pow(fmax / fmin, (sh - 1 - r) / sh), f1 = fmin * Math.pow(fmax / fmin, (sh - r) / sh);
    rowLo[r] = Math.max(1, Math.floor(f0 / sr * N));
    rowHi[r] = Math.max(rowLo[r] + 1, Math.ceil(f1 / sr * N));
  }
  const img = g.getImageData(0, wh, cols, sh), px = img.data;
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2 + 1);
  const norm = 4 / (wsum * wsum);
  for (let c = 0; c < cols; c++) {
    const center = Math.floor((c + 0.5) * per), start = center - N / 2;
    for (let i = 0; i < N; i++) { const j = start + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) mag[k] = (re[k] * re[k] + im[k] * im[k]) * norm;
    for (let r = 0; r < sh; r++) {
      let p = 0;
      for (let k = rowLo[r]; k < rowHi[r] && k <= N / 2; k++) if (mag[k] > p) p = mag[k];
      const dB = 10 * Math.log10(p + 1e-12);
      const [R, G, B] = cmap((dB + 100) / 80);
      const o = (r * cols + c) * 4;
      px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, wh);
  return base;
}

function renderChange(canvas) {
  const dpr = window.devicePixelRatio || 1, W = Math.round(canvas.clientWidth * dpr), H = Math.round(40 * dpr);
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d"), cv = S.detail?.curve;
  g.clearRect(0, 0, W, H);
  if (!cv) return;
  const top = 30;  // dB at the top of the strip
  const xEnd = W * (cv.seconds / S.maxDur), n = cv.values.length;
  g.fillStyle = css("--change"); g.globalAlpha = 0.85;
  g.beginPath(); g.moveTo(0, H);
  cv.values.forEach((v, i) => g.lineTo((i / Math.max(1, n - 1)) * xEnd, H - Math.min(1, v / top) * H));
  g.lineTo(xEnd, H); g.closePath(); g.fill();
  g.globalAlpha = 1;
  g.strokeStyle = css("--muted"); g.setLineDash([4 * dpr, 4 * dpr]);
  const y6 = H - (6 / top) * H;
  g.beginPath(); g.moveTo(0, y6); g.lineTo(W, y6); g.stroke(); g.setLineDash([]);
}

function renderAxis() {
  const ax = $("#axis");
  if (!ax) return;
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => S.maxDur / s <= 12) || 120;
  let h = "";
  for (let t = 0; t <= S.maxDur + 1e-6; t += step) h += `<span style="left:${(t / S.maxDur) * 100}%">${+t.toFixed(1)}s</span>`;
  ax.innerHTML = h;
}

function renderTracks() {
  document.querySelectorAll(".track").forEach((el) => {
    const t = S.tracks[+el.dataset.i];
    t.el = el;
    t.canvas = el.querySelector("canvas.main");
    t.change = el.querySelector("canvas.change");
    t.base = renderBase(t, t.canvas);
    if (t.change) renderChange(t.change);
    const info = el.querySelector(".info");
    if (t.buffer) info.textContent = `${t.buffer.duration.toFixed(2)} s · ${t.buffer.numberOfChannels} ch`;
  });
  draw();
}

function draw() {
  const now = currentTime();
  const spans = S.detail?.trace?.changed_spans || [];
  S.tracks.forEach((t, i) => {
    if (!t.canvas || !t.base) return;
    const g = t.canvas.getContext("2d"), W = t.canvas.width, H = t.canvas.height, X = (s) => (s / S.maxDur) * W;
    g.drawImage(t.base, 0, 0);
    // changed_spans: a band along the top + thin edges, so a whole-file span doesn't tint everything
    const dpr = window.devicePixelRatio || 1;
    for (const [a, b] of spans) {
      g.fillStyle = css("--span-edge");
      g.fillRect(X(a), 0, X(b) - X(a), 4 * dpr);
      g.fillRect(X(a), 0, dpr, H); g.fillRect(X(b) - dpr, 0, dpr, H);
    }
    if (S.seg && S.seg.track === i) {
      g.fillStyle = css("--seg"); g.fillRect(X(S.seg.a), 0, X(S.seg.b) - X(S.seg.a), H);
    }
    g.fillStyle = i === (P.playing ? P.track : S.active) ? css("--cursor") : "rgba(255,255,255,.45)";
    g.fillRect(X(now) - 1, 0, 2, H);
    t.el.classList.toggle("active", i === S.active);
  });
  const tl = $("#time");
  if (tl) tl.textContent = `${now.toFixed(2)} s`;
}

// ---------------------------------------------------------------- playback
function ensureCtx() {
  if (!P.ctx) P.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (P.ctx.state === "suspended") P.ctx.resume();
}

function currentTime() {
  if (!P.playing) return P.pausedAt;
  return Math.min(P.end ?? Infinity, P.offset + (P.ctx.currentTime - P.startCtx));
}

function play(i, offset, end = null) {
  const t = S.tracks[i];
  if (!t || !t.buffer) return;
  ensureCtx();
  stop(true);
  offset = Math.max(0, Math.min(offset, t.buffer.duration - 0.01));
  const node = P.ctx.createBufferSource();
  node.buffer = t.buffer;
  node.connect(P.ctx.destination);
  if (end != null) node.start(0, offset, Math.max(0.01, end - offset));
  else node.start(0, offset);
  Object.assign(P, { node, playing: true, track: i, offset, startCtx: P.ctx.currentTime, end: end ?? t.buffer.duration });
  S.active = i;
  node.onended = () => {
    if (P.node !== node) return;
    P.pausedAt = currentTime();
    P.playing = false; P.node = null;
    updateAB(); draw();
  };
  updateAB();
  requestAnimationFrame(tick);
}

function stop(keepTime = false) {
  if (P.node) {
    if (keepTime) P.pausedAt = currentTime();
    const n = P.node; P.node = null;
    try { n.stop(); } catch { /* already stopped */ }
  }
  P.playing = false;
  updateAB();
}

function tick() {
  draw();
  if (P.playing) requestAnimationFrame(tick);
}

function toggle() {
  if (P.playing) { stop(true); draw(); return; }
  const t = S.tracks[S.active];
  if (!t?.buffer) return;
  play(S.active, P.pausedAt >= t.buffer.duration - 0.02 ? 0 : P.pausedAt);
}

function switchTo(i) {  // A/B: keep the time position, change the track
  if (!S.tracks[i]?.buffer) return;
  const now = currentTime();
  S.seg = null;
  if (P.playing) play(i, now);
  else { S.active = i; P.pausedAt = now; updateAB(); draw(); }
}

function updateAB() {
  document.querySelectorAll("#ab button").forEach((b) => b.classList.toggle("on", +b.dataset.i === S.active));
  const bp = $("#btn-play");
  if (bp) bp.textContent = P.playing ? "❚❚ Pause" : "▶ Play";
}

function onTrackClick(e) {
  const el = e.target.closest(".track"), i = +el.dataset.i;
  const r = e.target.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * S.maxDur;
  S.seg = null;
  if (P.playing) play(i, t);
  else { S.active = i; P.pausedAt = t; updateAB(); draw(); }
}

function onSegClick(e) {
  const c = e.currentTarget, name = c.dataset.track;
  const i = S.tracks.findIndex((t) => t.name === name);
  if (i < 0 || !S.tracks[i].buffer) return;
  const a = c.dataset.a === "" ? 0 : +c.dataset.a;
  const b = c.dataset.b === "" ? S.tracks[i].buffer.duration : +c.dataset.b;
  S.seg = { track: i, a, b };
  play(i, a, b);
}

// ---------------------------------------------------------------- wiring
function move(delta) {
  const idx = S.shown.findIndex((s) => s.id === S.sel);
  const next = S.shown[Math.max(0, Math.min(S.shown.length - 1, idx + delta))];
  if (next && next.id !== S.sel) select(next.id);
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); toggle(); }
  else if (k === "a") switchTo(0);
  else if (k === "b") switchTo(S.tracks.length - 1);
  else if (k === "j") move(1);
  else if (k === "k") move(-1);
  else if (k === "/") { e.preventDefault(); $("#q").focus(); }
  else if (k === "arrowleft" || k === "arrowright") {
    e.preventDefault();
    const t = Math.max(0, currentTime() + (k === "arrowright" ? 1 : -1));
    if (P.playing) play(P.track, t); else { P.pausedAt = t; draw(); }
  }
});

$("#list").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) select(li.dataset.id); });
$("#q").addEventListener("input", renderList);
for (const id of ["f-modality", "f-flag", "sort"]) {
  const el = $("#" + id);
  if (id !== "f-modality") el.value = store.get(id, el.value);
  el.addEventListener("change", () => { store.set(id === "f-modality" ? "modality" : id, el.value); renderList(); });
}
window.addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== S.sel) select(id); });
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.tracks.some((t) => t.canvas)) renderTracks(); }, 200); });

(async () => {
  S.run = await fetch("/api/run").then((r) => r.json());
  $("#run-name").textContent = S.run.name;
  document.title = `${S.run.name} · Audio Editor Viewer`;
  await loadSamples();
  const start = location.hash.slice(1);
  select(S.samples.some((s) => s.id === start) ? start : S.shown[0]?.id);
})();

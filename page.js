// Studio audio: record takes (chosen mic, input gain), edit them on one timeline (waveforms, drag the edges to trim,
// drag the top strip to reorder, drag on the waveform to select then Delete, S to split, undo), export one MP3.
// Clips are non-destructive views of the recorded files (<audio folder>/<id>/takes/*.webm); api.py runs ffmpeg.

const PIECE = 3 * 1024 * 1024;            // raw bytes per upload request (base64 stays under the 5 MB limit)
const RES = 100;                          // waveform bins per second
const PAD = 12;                           // timeline left/right padding (px)
const H = 170, RULER = 20, STRIP = 22;    // timeline height, ruler, clip top strip (drag to move)
const LS = { mic: "studio-audio:mic", last: "studio-audio:last", raw: "studio-audio:raw", gain: "studio-audio:gain" };

const I = (d, fill = false) => `<svg viewBox="0 0 24 24" width="16" height="16" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${d}</svg>`;
const SVG = {
  play: I('<path d="M7 5v14l12-7z"/>', true),
  pause: I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>', true),
  cut: I('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
  del: I('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
  undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>'),
  redo: I('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>'),
  zin: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/>'),
  zout: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
  gear: I('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
};

const CSS = `
.sa{display:grid;grid-template-columns:200px minmax(0,1fr);gap:20px;align-items:start}
@media (max-width:820px){.sa{grid-template-columns:minmax(0,1fr)}}
.sa-list{display:flex;flex-direction:column;gap:2px}
.sa-proj{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:7px 10px;border-radius:8px;border:none;background:none;color:var(--muted-foreground);cursor:pointer;font:inherit}
.sa-proj:hover{background:var(--muted);color:var(--foreground)}
.sa-proj.sa-on{background:var(--muted);color:var(--foreground);font-weight:600}
.sa-proj span:last-child{font-variant-numeric:tabular-nums;font-size:12px;opacity:.7;font-weight:400}
.sa-name{border:none;background:none;color:inherit;font-size:20px;font-weight:600;font-family:inherit;padding:2px 0;outline:none;min-width:0;flex:1}
.sa-name:focus{box-shadow:0 1px 0 var(--primary)}
.sa-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.sa-rec{width:44px;height:44px;border-radius:50%;border:2px solid var(--border);cursor:pointer;display:grid;place-items:center;background:none;flex:none}
.sa-rec i{width:18px;height:18px;border-radius:50%;background:var(--destructive);transition:border-radius .15s,transform .15s}
.sa-rec.sa-live{border-color:var(--destructive)}
.sa-rec.sa-live i{border-radius:3px;transform:scale(.85);animation:sa-p 1s infinite}
@keyframes sa-p{50%{opacity:.4}}
.sa-num{font-variant-numeric:tabular-nums}
.sa-meter{position:relative;flex:1;min-width:120px;height:6px;border-radius:3px;background:var(--muted);overflow:hidden}
.sa-meter i{position:absolute;inset:0 auto 0 0;width:0;background:linear-gradient(90deg,var(--success) 0 75%,var(--warning) 75% 92%,var(--destructive) 92%);background-size:var(--sa-w,300px) 100%}
.sa-meter b{position:absolute;top:0;bottom:0;width:2px;left:0;background:var(--foreground);opacity:.6}
.sa-gain{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted-foreground)}
.sa-gain input{width:110px;accent-color:var(--primary)}
.sa-gain output{min-width:52px;text-align:right}
.sa-set{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:13px}
.sa-tl{position:relative;overflow-x:auto;overflow-y:hidden;border-radius:10px;background:color-mix(in srgb,var(--muted) 50%,transparent)}
.sa-tl canvas{display:block;position:sticky;left:0;touch-action:none}
.sa-tools{display:flex;align-items:center;gap:2px}
.sa-tools .sa-num{margin:0 10px;font-size:13px}
.sa-ib{width:30px;height:30px;display:grid;place-items:center;border:none;border-radius:7px;background:none;color:var(--foreground);cursor:pointer}
.sa-ib:hover:not(:disabled){background:var(--muted)}
.sa-ib:disabled{opacity:.3;cursor:default}
.sa-out{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted-foreground);flex-wrap:wrap}
.sa-out:empty{display:none}
.sa-out a{color:var(--primary);text-decoration:none;font-weight:600}
.sa-out code{user-select:all;word-break:break-all}
@media (max-width:820px){
  .sa{gap:12px}
  .sa-list{flex-direction:row;overflow-x:auto;gap:6px;padding-bottom:4px;scrollbar-width:none}
  .sa-list::-webkit-scrollbar{display:none}
  .sa-list .ui-btn{margin:0!important;flex:none}
  .sa-proj{flex:none;width:auto;max-width:200px;border:1px solid var(--border);border-radius:999px;padding:6px 12px}
  .sa-proj.sa-on{border-color:var(--primary)}
}
@media (max-width:600px){
  .sa-card{padding:14px!important}
  .sa-name{font-size:17px}
  .sa-bar{gap:10px}
  .sa-meter{order:3;flex-basis:100%}
  .sa-gain{order:4;flex:1}
  .sa-gain input{flex:1;width:auto}
  .sa-bar .sa-ib{margin-left:auto}
  .sa-set select{min-width:0!important;width:100%}
  .sa-tools .sa-num{margin:0 4px;font-size:12px;flex:1;min-width:0}
  .sa-ib{width:38px;height:38px}
  .sa-export-label{display:none}
}
@media (pointer:coarse){.sa-zoom{display:none!important}}
`;

// UI texts: English, or French when the app is in French (ctx.lang)
const TEXTS = {
  en: {
    title: "Audio studio", noMic: "This browser gives no access to the microphone (HTTPS is required).",
    micDenied: "Microphone access denied: allow it in the browser (icon left of the address).",
    uploadFailed: "Uploading the take failed: ", saveFailed: "Saving the edit failed: ", playFailed: "Cannot play: ",
    uploading: "Uploading the take…", hint: "Press the red button (or R) to record a take.",
    confirmDelete: (n) => `Delete “${n}”? (it goes to the .trash folder of the audio folder)`,
    newShort: "New", exportTitle: "Joins the takes and exports one MP3 at voice-over loudness (−16 LUFS)",
    meter: "Level: aim for yellow on loud parts, never red", gainTitle: "Input gain (double-click: 0 dB)",
    settings: "Microphone and settings", stop: "Stop (R)", record: "Record a take (R)", sending: "uploading…",
    mic: (i) => `Microphone ${i}`, defaultMic: "Default microphone", enableMic: "Turn the microphone on",
    processing: "Noise reduction and auto gain", deleteRec: "Delete the recording",
    play: "Play / pause (Space)", split: "Split at the playhead (S)", delSel: "Delete the selection (Del)",
    delTake: "Delete the take (Del)", undo: "Undo (Ctrl+Z)", redo: "Redo (Ctrl+Shift+Z)",
    zoomOut: "Zoom out (Ctrl + wheel)", zoomIn: "Zoom in (Ctrl + wheel)", exporting: "Export…", export: "Export ",
    download: "Download the MP3", mb: "MB", none: "No recording open",
    noneHint: "Create a recording, then add as many takes as you like.", newRec: "New recording", gain: "Gain",
    take: "Take",
    defaultName: () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; },
  },
  fr: {
    title: "Studio audio", noMic: "Ce navigateur ne donne pas accès au micro (il faut HTTPS).",
    micDenied: "Accès au micro refusé : autorise-le dans le navigateur (icône à gauche de l'adresse).",
    uploadFailed: "Envoi de la prise raté : ", saveFailed: "Enregistrement du montage raté : ", playFailed: "Lecture impossible : ",
    uploading: "Envoi de la prise…", hint: "Appuie sur le bouton rouge (ou R) pour enregistrer une prise.",
    confirmDelete: (n) => `Supprimer « ${n} » ? (il part dans le dossier .trash du dossier audio)`,
    newShort: "Nouveau", exportTitle: "Colle les prises et exporte un MP3 au volume d'une voix off (−16 LUFS)",
    meter: "Niveau : vise le jaune sur les passages forts, jamais le rouge", gainTitle: "Gain d'entrée (double-clic : 0 dB)",
    settings: "Micro et réglages", stop: "Arrêter (R)", record: "Enregistrer une prise (R)", sending: "envoi…",
    mic: (i) => `Micro ${i}`, defaultMic: "Micro par défaut", enableMic: "Activer le micro",
    processing: "Réduction de bruit et gain auto", deleteRec: "Supprimer l'enregistrement",
    play: "Lire / pause (Espace)", split: "Couper en deux à la tête de lecture (S)", delSel: "Supprimer la sélection (Suppr)",
    delTake: "Supprimer la prise (Suppr)", undo: "Annuler (Ctrl+Z)", redo: "Rétablir (Ctrl+Maj+Z)",
    zoomOut: "Dézoomer (Ctrl + molette)", zoomIn: "Zoomer (Ctrl + molette)", exporting: "Export…", export: "Exporter ",
    download: "Télécharger le MP3", mb: "Mo", none: "Aucun enregistrement ouvert",
    noneHint: "Crée un enregistrement, puis ajoute autant de prises que tu veux.", newRec: "Nouvel enregistrement", gain: "Gain",
    take: "Prise",
    defaultName: () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `Enregistrement ${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}h${p(d.getMinutes())}`; },
  },
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;            // only for the static SVGs above
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const fmt = (s, dec = 1) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(dec).padStart(dec ? 3 + dec : 2, "0")}`;
};
const raw = (path, v, dl) => `/api/files/raw?path=${encodeURIComponent(path)}&v=${encodeURIComponent(v || "")}${dl ? "&download=1" : ""}`;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
const errMsg = (e) => e?.message || e?.detail?.message || String(e);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbLin = (db) => Math.pow(10, (db || 0) / 20);
const kept = (c) => Math.max(0, c.duration - c.trim_start - c.trim_end);
const copy = (clips) => clips.map((c) => ({ ...c }));
const sdb = (db) => `${db > 0 ? "+" : ""}${Number(db).toFixed(1)} dB`;
const body = (clips) => ({ takes: clips.map(({ id, file, label, trim_start, trim_end, gain }) => ({ id, file, label, trim_start, trim_end, gain })) });

function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function peaksOf(buf) {
  const n = Math.ceil(buf.duration * RES);
  const out = new Float32Array(n);
  const step = buf.sampleRate / RES;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const e = Math.min(d.length, Math.floor((i + 1) * step));
      for (let j = Math.floor(i * step); j < e; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
      if (m > out[i]) out[i] = m;
    }
  }
  return out;
}

export function mount(el, ctx) {
  const T = TEXTS[ctx.lang] || TEXTS[String(ctx.lang || "").slice(0, 2)] || TEXTS.en;
  const st = {
    projects: [], cur: null, clips: [], undo: [], redo: [], sel: null, range: null,
    devices: [], mic: localStorage.getItem(LS.mic) || "", rawMic: localStorage.getItem(LS.raw) === "1",
    inGainDb: Number(localStorage.getItem(LS.gain) || 0),
    ac: null, stream: null, src: null, inGain: null, analyser: null, dest: null, raf: 0, hold: { v: 0, t: 0 },
    recorder: null, recStart: 0, queue: Promise.resolve(), pending: 0, poll: 0, saveT: 0,
    head: 0, play: null, pps: null, drag: null,
  };
  const buffers = new Map();       // file -> Promise<AudioBuffer>
  const peaks = new Map();         // file -> Float32Array
  let colors = {};

  // ---------- skeleton ----------
  el.innerHTML = "";
  const probe = h("span", { style: "display:none" });
  const errBox = h("div", { class: "ui-callout ui-error", hidden: true });
  const listCol = h("div", { class: "sa-list" });
  const main = h("div", { style: "min-width:0" });
  el.append(h("style", {}, CSS), probe, h("div", { class: "ui-page", style: "max-width:1300px" },
    h("h1", { class: "ui-h1" }, T.title), errBox, h("div", { class: "sa" }, listCol, main)));

  const showErr = (e) => { errBox.hidden = !e; errBox.textContent = e ? errMsg(e) : ""; };

  function readColors() {
    const get = (v, fb) => { probe.style.color = fb; probe.style.color = `var(${v}, ${fb})`; return getComputedStyle(probe).color; };
    colors = {
      primary: get("--primary", "#6366f1"), fg: get("--foreground", "#ddd"), muted: get("--muted-foreground", "#888"),
      border: get("--border", "#444"), card: get("--card", "#111"), red: get("--destructive", "#e5484d"),
    };
  }
  readColors();
  const colorTimer = setInterval(() => { readColors(); draw(); }, 2000);

  // ---------- audio context, buffers ----------
  function audioCtx() {
    if (!st.ac) st.ac = new AudioContext();
    if (st.ac.state === "suspended") st.ac.resume().catch(() => {});
    return st.ac;
  }

  function loadBuffer(c, blob = null) {
    if (buffers.has(c.file)) return buffers.get(c.file);
    const p = (async () => {
      const data = blob ? await blob.arrayBuffer() : await (await fetch(raw(c.path, c.at), { credentials: "same-origin" })).arrayBuffer();
      const buf = await audioCtx().decodeAudioData(data);
      peaks.set(c.file, peaksOf(buf));
      draw();
      return buf;
    })();
    p.catch(() => buffers.delete(c.file));
    buffers.set(c.file, p);
    return p;
  }

  // ---------- microphone ----------
  async function listDevices() {
    try { st.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); }
    catch { st.devices = []; }
  }

  function closeStream() {
    cancelAnimationFrame(st.raf);
    st.stream?.getTracks().forEach((t) => t.stop());
    try { st.src?.disconnect(); st.inGain?.disconnect(); } catch {}
    st.stream = st.src = st.inGain = st.analyser = st.dest = null;
  }

  async function openStream() {
    if (st.stream) return st.stream;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(T.noMic);
    const proc = !st.rawMic;
    const c = { echoCancellation: proc, noiseSuppression: proc, autoGainControl: proc, channelCount: 1 };
    if (st.mic) c.deviceId = { exact: st.mic };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: c }); }
    catch (e) {
      if (!st.mic || !["OverconstrainedError", "NotFoundError"].includes(e.name)) throw e;
      st.mic = ""; delete c.deviceId;                   // the saved mic is gone: fall back to the default one
      stream = await navigator.mediaDevices.getUserMedia({ audio: c });
    }
    const ac = audioCtx();
    st.stream = stream;
    st.src = ac.createMediaStreamSource(stream);
    st.inGain = ac.createGain();
    st.inGain.gain.value = dbLin(st.inGainDb);
    st.analyser = ac.createAnalyser();
    st.analyser.fftSize = 1024;
    st.dest = ac.createMediaStreamDestination();
    st.dest.channelCount = 1;
    st.src.connect(st.inGain);
    st.inGain.connect(st.analyser);
    st.inGain.connect(st.dest);
    const used = stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (used && !st.mic) st.mic = used;
    await listDevices();
    renderSettings();
    meterLoop();
    return stream;
  }

  function meterLoop() {
    cancelAnimationFrame(st.raf);
    const buf = new Float32Array(st.analyser.fftSize);
    const tick = () => {
      if (!st.analyser) return;
      st.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) { const a = v < 0 ? -v : v; if (a > peak) peak = a; }
      const pos = clamp(((peak > 0 ? 20 * Math.log10(peak) : -60) + 60) / 60, 0, 1);
      const now = performance.now();
      if (pos >= st.hold.v || now - st.hold.t > 1200) st.hold = { v: pos, t: now };
      meter.style.setProperty("--sa-w", `${meter.clientWidth}px`);
      meter.firstChild.style.width = `${pos * 100}%`;
      meter.lastChild.style.left = `calc(${st.hold.v * 100}% - 2px)`;
      if (st.recorder) timer.textContent = fmt((now - st.recStart) / 1000);
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  }

  // ---------- recording ----------
  async function toggleRec() {
    if (!st.cur) return;
    if (st.recorder) return stopRec();
    stopPlay();
    try {
      showErr("");
      await audioCtx().resume();                          // a suspended context would record silence
      await openStream();
      const mime = pickMime();
      const rec = new MediaRecorder(st.dest.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 160000 });
      const chunks = [];
      const pid = st.cur.id;
      const t0 = performance.now();
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => enqueueUpload(pid, new Blob(chunks, { type: rec.mimeType || mime }), (performance.now() - t0) / 1000);
      rec.start(1000);
      st.recorder = rec;
      st.recStart = t0;
      renderBar();
    } catch (e) {
      showErr(e.name === "NotAllowedError" ? T.micDenied : e);
    }
  }

  function stopRec() {
    const rec = st.recorder;
    st.recorder = null;
    if (rec && rec.state !== "inactive") rec.stop();
    renderBar();
  }

  function enqueueUpload(pid, blob, duration) {
    st.pending++;
    renderBar();
    st.queue = st.queue.then(async () => {
      try {
        const sid = newId();
        for (let off = 0; off < blob.size; off += PIECE) {
          const data = b64(await blob.slice(off, off + PIECE).arrayBuffer());
          await ctx.api(`projects/${pid}/upload`, { method: "POST", body: { sid, offset: off, data } });
        }
        const p = await ctx.api(`projects/${pid}/takes`, { method: "POST", body: { sid, duration, label: T.take } });
        const added = p.takes.find((t) => t.id === sid);
        if (st.cur?.id === pid && added) {
          st.cur = { ...p, takes: st.clips };
          loadBuffer(added, blob);
          commit([...st.clips, added], { save: false });
        }
      } catch (e) {
        showErr(T.uploadFailed + errMsg(e));
      } finally {
        st.pending--;
        renderBar();
        refreshList();
      }
    });
  }

  // ---------- editing ----------
  function commit(next, { save = true, undoable = true } = {}) {
    stopPlay();
    if (undoable) { st.undo.push(copy(st.clips)); if (st.undo.length > 200) st.undo.shift(); st.redo = []; }
    st.clips = next;
    if (st.sel && !next.some((c) => c.id === st.sel)) st.sel = null;
    st.head = clamp(st.head, 0, totalLen());
    if (save) scheduleSave();
    renderTools(); draw();
  }

  function scheduleSave() {
    clearTimeout(st.saveT);
    st.saveT = setTimeout(saveNow, 350);
  }

  function saveNow() {
    st.saveT = 0;
    const pid = st.cur?.id;
    if (!pid) return;
    const b = body(st.clips);
    st.queue = st.queue.then(async () => {
      try {
        const p = await ctx.api(`projects/${pid}/takes`, { method: "PUT", body: b });
        if (st.cur?.id === pid) st.cur = { ...p, takes: st.clips };
        refreshList();
      } catch (e) { showErr(T.saveFailed + errMsg(e)); }
    });
  }

  function undo() {
    if (!st.undo.length) return;
    st.redo.push(copy(st.clips));
    commit(st.undo.pop(), { undoable: false });
  }
  function redo() {
    if (!st.redo.length) return;
    st.undo.push(copy(st.clips));
    commit(st.redo.pop(), { undoable: false });
  }

  const totalLen = () => st.clips.reduce((a, c) => a + kept(c), 0);
  function layout(clips = st.clips) {
    let x = 0;
    return clips.map((c) => { const o = { c, start: x, len: kept(c) }; x += o.len; return o; });
  }
  const clipAt = (t) => layout().find((o) => t >= o.start && t < o.start + o.len) || null;

  function splitAt(t) {
    const o = clipAt(t);
    if (!o) return;
    const off = t - o.start;
    if (off < 0.05 || o.len - off < 0.05) return;
    const at = o.c.trim_start + off;                    // position in the source file
    const a = { ...o.c, trim_end: o.c.duration - at };
    const b = { ...o.c, id: newId(), trim_start: at };
    commit(st.clips.flatMap((c) => (c.id === o.c.id ? [a, b] : [c])));
  }

  // remove the timeline range [a, b] from every clip it touches (a clip is split when the range is inside it)
  function removeRange([a, b]) {
    const next = [];
    for (const o of layout()) {
      const c = o.c;
      const s = Math.max(a, o.start), e = Math.min(b, o.start + o.len);
      if (e - s < 0.01) { next.push(c); continue; }
      const sa = c.trim_start + (s - o.start), sb = c.trim_start + (e - o.start);
      const left = sa - c.trim_start >= 0.05, right = c.duration - c.trim_end - sb >= 0.05;
      if (left) next.push({ ...c, trim_end: c.duration - sa });
      if (right) next.push({ ...c, id: left ? newId() : c.id, trim_start: sb });
    }
    st.range = null;
    st.head = a;
    commit(next);
  }

  function deleteSomething() {
    if (st.range) removeRange(st.range);
    else if (st.sel) commit(st.clips.filter((c) => c.id !== st.sel));
  }

  // ---------- playback (Web Audio: exact trims) ----------
  function stopPlay() {
    if (!st.play) return;
    for (const n of st.play.nodes) { try { n.stop(); n.disconnect(); } catch {} }
    cancelAnimationFrame(st.play.raf);
    st.play = null;
    renderTools(); draw();
  }

  async function playFrom(t, until = null) {
    stopPlay();
    const total = totalLen();
    if (!total) return;
    if (t >= total - 0.02) t = 0;
    until = until ?? total;
    const segs = [];
    for (const o of layout()) {
      const s = Math.max(t, o.start), e = Math.min(until, o.start + o.len);
      if (e - s > 0.005) segs.push({ c: o.c, from: o.c.trim_start + (s - o.start), len: e - s });
    }
    const ac = audioCtx();
    const token = {};
    st.play = { nodes: [], raf: 0, token };
    renderTools();
    let bufs;
    try { bufs = await Promise.all(segs.map((s) => loadBuffer(s.c))); }
    catch (e) { st.play = null; renderTools(); return showErr(T.playFailed + errMsg(e)); }
    if (st.play?.token !== token) return;
    const t0 = ac.currentTime + 0.05;
    let acc = 0;
    segs.forEach((s, i) => {
      const n = ac.createBufferSource();
      n.buffer = bufs[i];
      const g = ac.createGain();
      g.gain.value = dbLin(s.c.gain);
      n.connect(g).connect(ac.destination);
      n.start(t0 + acc, s.from, s.len);
      st.play.nodes.push(n);
      acc += s.len;
    });
    const tick = () => {
      if (st.play?.token !== token) return;
      const el2 = ac.currentTime - t0;
      st.head = t + clamp(el2, 0, acc);
      if (el2 >= acc) { stopPlay(); updateClock(); return; }
      follow(); draw(); updateClock();
      st.play.raf = requestAnimationFrame(tick);
    };
    st.play.raf = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (st.play) return stopPlay();
    if (st.range) playFrom(st.range[0], st.range[1]);
    else playFrom(st.head);
  }

  // ---------- timeline ----------
  const tlWrap = h("div", { class: "sa-tl" });
  const cv = h("canvas", { height: String(H) });
  const spacer = h("div", { style: "height:1px;margin-top:-1px" });
  tlWrap.append(cv, spacer);

  const fitPps = () => ((tlWrap.clientWidth || 800) - 2 * PAD) / Math.max(totalLen(), 1);
  const pps = () => st.pps ?? fitPps();
  const t2x = (t) => PAD + t * pps() - tlWrap.scrollLeft;
  const x2t = (x) => (x + tlWrap.scrollLeft - PAD) / pps();

  function follow() {
    const x = t2x(st.head), w = tlWrap.clientWidth;
    if (x > w - 40 || x < 0) tlWrap.scrollLeft = Math.max(0, st.head * pps() + PAD - w * 0.25);
  }

  function drawWave(g, file, from, to, x, w, mid, half, W) {
    const pk = peaks.get(file);
    if (!pk) { g.globalAlpha = 0.3; g.fillRect(x, mid - 1, w, 2); g.globalAlpha = 1; return; }
    const span = to - from;
    for (let px = Math.max(0, Math.floor(-x)); px < Math.min(w, W - x); px++) {
      const a = Math.floor((from + (px / w) * span) * RES);
      const b = Math.max(a + 1, Math.floor((from + ((px + 1) / w) * span) * RES));
      let m = 0;
      for (let i = a; i < b && i < pk.length; i++) if (pk[i] > m) m = pk[i];
      const hgt = Math.max(0.5, Math.min(1, Math.sqrt(m)) * half);   // sqrt: quiet speech stays readable
      g.fillRect(x + px, mid - hgt, 1, hgt * 2);
    }
  }

  function draw() {
    const W = tlWrap.clientWidth;
    if (!W) return;
    const p = pps();
    spacer.style.width = `${Math.max(W, totalLen() * p + 2 * PAD)}px`;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.style.width = `${W}px`; }
    if (cv.height !== Math.round(H * dpr)) { cv.height = Math.round(H * dpr); cv.style.height = `${H}px`; }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // ruler
    g.fillStyle = colors.muted; g.font = "10px system-ui, sans-serif";
    const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * p >= 64) || 600;
    for (let t = Math.max(0, Math.floor(x2t(0) / step) * step); t <= x2t(W) + step; t += step) {
      const x = Math.round(t2x(t));
      g.globalAlpha = 0.5; g.fillRect(x, RULER - 5, 1, 5); g.globalAlpha = 1;
      g.fillText(fmt(t, step < 1 ? 1 : 0), x + 3, 11);
    }

    const top = RULER + 4, hh = H - top - 6;
    if (!st.clips.length) {
      g.font = "13px system-ui, sans-serif";
      g.fillText(st.pending ? T.uploading : T.hint, PAD + 4, top + hh / 2 + 4);
      return;
    }
    const d = st.drag;
    const lay = d?.frozen || layout();
    const mid = top + STRIP + (hh - STRIP) / 2, half = (hh - STRIP) / 2 - 6;
    const box = (x, w) => { g.beginPath(); g.roundRect ? g.roundRect(x + 1, top, Math.max(2, w - 2), hh, 6) : g.rect(x + 1, top, Math.max(2, w - 2), hh); };
    const clip = (c, x, w, alpha = 1) => {
      const sel = c.id === st.sel;
      g.globalAlpha = alpha;
      box(x, w); g.fillStyle = colors.card; g.fill();
      g.save(); g.clip();
      g.globalAlpha = alpha * (sel ? 0.28 : 0.14); g.fillStyle = colors.primary; g.fillRect(x, top, w, STRIP);
      g.globalAlpha = alpha;
      drawWave(g, c.file, c.trim_start, c.duration - c.trim_end, x, w, mid, half, W);
      if (w > 36) { g.fillStyle = colors.fg; g.font = "11px system-ui, sans-serif"; g.fillText(c.label, x + 7, top + 12.5); }
      g.restore();
      box(x, w); g.lineWidth = sel ? 1.5 : 1; g.strokeStyle = sel ? colors.primary : colors.border; g.stroke();
      g.globalAlpha = 1;
    };
    for (const o of lay) {
      let c = o.c, x = t2x(o.start);
      if (d?.mode === "trim" && c.id === d.id) {
        c = { ...c, trim_start: d.ts, trim_end: d.te };
        if (d.edge === "l") x = t2x(o.start + (d.ts - d.ts0));
      }
      const w = kept(c) * p;
      if (x + w < -5 || x > W + 5) continue;
      clip(c, x, w, d?.mode === "move" && c.id === d.id ? 0.25 : 1);
    }
    if (d?.mode === "move") {
      const o = lay.find((q) => q.c.id === d.id);
      clip(o.c, d.x - d.grab, o.len * p, 0.85);
      const ix = d.insert < lay.length ? t2x(lay[d.insert].start) : t2x(lay.reduce((a, q) => a + q.len, 0));
      g.fillStyle = colors.fg; g.fillRect(ix - 1, top - 3, 2, hh + 6);
    }
    if (st.range) {
      const a = t2x(st.range[0]), b = t2x(st.range[1]);
      g.fillStyle = colors.fg;
      g.globalAlpha = 0.18; g.fillRect(a, top, b - a, hh);
      g.globalAlpha = 0.7; g.fillRect(Math.round(a), top, 1, hh); g.fillRect(Math.round(b), top, 1, hh);
      g.globalAlpha = 1;
    }
    const hx = Math.round(t2x(st.head)) + 0.5;
    g.strokeStyle = colors.red; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(hx, 4); g.lineTo(hx, H); g.stroke();
    g.fillStyle = colors.red; g.beginPath(); g.moveTo(hx - 5, 0); g.lineTo(hx + 5, 0); g.lineTo(hx, 7); g.fill();
  }

  function hit(x, y, touch = false) {
    if (y < RULER) return null;
    const p = pps(), tol = touch ? 14 : 5;
    for (const o of layout()) {
      const x0 = t2x(o.start), x1 = x0 + o.len * p;
      if (x < x0 - tol || x > x1 + tol) continue;
      const wide = o.len * p > (touch ? 40 : 16);
      if (wide && Math.abs(x - x0) <= tol) return { o, part: "l" };
      if (wide && Math.abs(x - x1) <= tol) return { o, part: "r" };
      if (x >= x0 && x <= x1) return { o, part: y < RULER + 4 + STRIP ? "strip" : "wave" };
    }
    return null;
  }

  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // two fingers on the timeline: pinch = zoom, slide = scroll (one finger edits, like the mouse)
  const touches = new Map();
  let pinch = null;
  const pinchState = () => {
    const [a, b] = [...touches.values()];
    return { mid: (a.x + b.x) / 2, dist: Math.max(20, Math.abs(a.x - b.x)) };
  };

  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || st.recorder) return;
    const { x, y } = pos(e);
    cv.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x, y });
      if (touches.size === 2) {
        if (st.drag?.mode === "select") st.range = null;
        st.drag = null;                                  // the first finger was not an edit
        const s = pinchState();
        pinch = { ...s, t: x2t(s.mid), pps0: pps() };
        draw();
        return;
      }
      if (touches.size > 2) return;
    }
    const ht = hit(x, y, e.pointerType === "touch");
    stopPlay();
    st.sel = ht ? ht.o.c.id : null;
    if (ht?.part === "l" || ht?.part === "r") {
      const c = ht.o.c;
      st.drag = { mode: "trim", edge: ht.part, id: c.id, c, x0: x, ts0: c.trim_start, te0: c.trim_end, ts: c.trim_start, te: c.trim_end, frozen: layout() };
    } else if (ht?.part === "strip") {
      st.drag = { mode: "press", id: ht.o.c.id, x0: x, x, grab: x - t2x(ht.o.start), frozen: layout(), insert: 0 };
    } else {
      const t = clamp(x2t(x), 0, totalLen());
      st.range = null;
      st.head = t;
      st.drag = { mode: "select", t0: t, x0: x };
    }
    renderTools(); draw();
  });

  cv.addEventListener("pointermove", (e) => {
    const { x, y } = pos(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x, y });
    if (pinch) {
      if (touches.size < 2) return;
      const s = pinchState();
      st.pps = clamp(pinch.pps0 * (s.dist / pinch.dist), 2, 2000);
      if (st.pps <= fitPps()) st.pps = null;
      draw();
      tlWrap.scrollLeft = Math.max(0, pinch.t * pps() + PAD - s.mid);
      draw();
      return;
    }
    const d = st.drag;
    if (!d) {
      const ht = hit(x, y);
      cv.style.cursor = ht?.part === "l" || ht?.part === "r" ? "ew-resize" : ht?.part === "strip" ? "grab" : "text";
      return;
    }
    if (d.mode === "trim") {
      const dt = (x - d.x0) / pps(), c = d.c;
      if (d.edge === "l") d.ts = clamp(d.ts0 + dt, 0, c.duration - c.trim_end - 0.05);
      else d.te = clamp(d.te0 - dt, 0, c.duration - c.trim_start - 0.05);
    } else if (d.mode === "press" && Math.abs(x - d.x0) > 4) {
      d.mode = "move"; cv.style.cursor = "grabbing";
    } else if (d.mode === "select" && Math.abs(x - d.x0) > 3) {
      const t = clamp(x2t(x), 0, totalLen());
      st.range = [Math.min(d.t0, t), Math.max(d.t0, t)];
      updateClock();
    }
    if (d.mode === "move") {
      d.x = x;
      const t = x2t(x);
      d.insert = d.frozen.findIndex((q) => t < q.start + q.len / 2);
      if (d.insert < 0) d.insert = d.frozen.length;
    }
    draw();
  });

  const up = (e) => {
    touches.delete(e.pointerId);
    if (pinch) { if (!touches.size) { pinch = null; renderTools(); } return; }
    const d = st.drag;
    st.drag = null;
    cv.style.cursor = "";
    if (!d) return;
    if (d.mode === "trim" && (d.ts !== d.ts0 || d.te !== d.te0)) {
      commit(st.clips.map((c) => (c.id === d.id ? { ...c, trim_start: +d.ts.toFixed(3), trim_end: +d.te.toFixed(3) } : c)));
    } else if (d.mode === "move") {
      const from = st.clips.findIndex((c) => c.id === d.id);
      const to = d.insert > from ? d.insert - 1 : d.insert;
      if (to !== from) {
        const next = [...st.clips];
        next.splice(to, 0, ...next.splice(from, 1));
        commit(next);
      }
    } else if (d.mode === "select" && st.range && st.range[1] - st.range[0] < 0.02) st.range = null;
    renderTools(); draw();
  };
  cv.addEventListener("contextmenu", (e) => e.preventDefault());   // long press on a phone
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;                 // ctrl + wheel = zoom around the pointer
    e.preventDefault();
    const { x } = pos(e);
    const t = x2t(x);
    st.pps = clamp(pps() * (e.deltaY < 0 ? 1.25 : 0.8), 2, 2000);
    if (st.pps <= fitPps()) st.pps = null;
    draw();
    tlWrap.scrollLeft = Math.max(0, t * pps() + PAD - x);
    renderTools(); draw();
  }, { passive: false });
  tlWrap.addEventListener("scroll", () => draw());
  const ro = new ResizeObserver(() => draw());
  ro.observe(tlWrap);

  function zoom(f) {
    st.pps = clamp(pps() * f, 2, 2000);
    if (st.pps <= fitPps()) st.pps = null;
    draw();
    tlWrap.scrollLeft = Math.max(0, st.head * pps() + PAD - tlWrap.clientWidth / 2);
    renderTools(); draw();
  }

  // ---------- data ----------
  async function refreshList() {
    try { st.projects = (await ctx.api("projects")).projects; renderList(); } catch (e) { showErr(e); }
  }

  async function openProject(id) {
    if (st.recorder) return;
    stopPlay();
    if (st.saveT) { clearTimeout(st.saveT); saveNow(); }
    try {
      const p = await ctx.api(`projects/${id}`);
      st.cur = p;
      st.clips = p.takes.map((t) => ({ gain: 0, ...t }));
      Object.assign(st, { undo: [], redo: [], sel: null, range: null, head: 0, pps: null });
      localStorage.setItem(LS.last, id);
      renderList(); renderMain();
      for (const c of st.clips) loadBuffer(c).catch(() => {});
      if (p.export?.state === "running") watchExport();
    } catch {
      st.cur = null; localStorage.removeItem(LS.last); renderMain();
    }
  }

  async function createProject() {
    if (st.recorder) return;
    try {
      const p = await ctx.api("projects", { method: "POST", body: { name: T.defaultName() } });
      await refreshList();
      await openProject(p.id);
      nameIn.select();
    } catch (e) { showErr(e); }
  }

  function startExport() {
    clearTimeout(st.saveT);
    const pid = st.cur.id;
    saveNow();
    st.cur.export = { ...(st.cur.export || {}), state: "running" };
    renderOut();
    st.queue = st.queue.then(async () => {
      try {
        const p = await ctx.api(`projects/${pid}/export`, { method: "POST", body: { normalize: true } });
        if (st.cur?.id === pid) { st.cur = { ...p, takes: st.clips }; renderOut(); watchExport(); }
      } catch (e) { showErr(e); }
    });
  }

  function watchExport() {
    clearInterval(st.poll);
    st.poll = setInterval(async () => {
      if (!st.cur) return clearInterval(st.poll);
      try {
        const p = await ctx.api(`projects/${st.cur.id}`);
        if (p.export?.state !== "running") {
          clearInterval(st.poll);
          st.cur = { ...p, takes: st.clips };
          renderOut(); refreshList();
        }
      } catch { clearInterval(st.poll); }
    }, 1200);
  }

  async function deleteProject() {
    const p = st.cur;
    if (!p || st.recorder || !confirm(T.confirmDelete(p.name))) return;
    try {
      stopPlay(); clearTimeout(st.saveT);
      await ctx.api(`projects/${p.id}`, { method: "DELETE" });
      st.cur = null; st.clips = []; localStorage.removeItem(LS.last); renderMain(); refreshList();
    } catch (e) { showErr(e); }
  }

  // ---------- rendering ----------
  function renderList() {
    listCol.replaceChildren(
      h("button", { class: "ui-btn ui-outline ui-sm", style: "margin-bottom:8px", onclick: createProject }, ctx.icon("plus"), T.newShort),
      ...st.projects.map((p) => h("button", { class: `sa-proj${st.cur?.id === p.id ? " sa-on" : ""}`, title: p.name, onclick: () => openProject(p.id) },
        h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, p.name), h("span", {}, fmt(p.duration, 0)))));
  }

  const nameIn = h("input", { class: "sa-name", spellcheck: "false",
    onchange: async (e) => {
      try { const p = await ctx.api(`projects/${st.cur.id}`, { method: "PATCH", body: { name: e.target.value } }); st.cur = { ...p, takes: st.clips }; refreshList(); }
      catch (x) { showErr(x); }
    },
    onkeydown: (e) => e.key === "Enter" && e.target.blur() });
  const exportBtn = h("button", { class: "ui-btn ui-sm", title: T.exportTitle, onclick: startExport });
  const recBtn = h("button", { class: "sa-rec", onclick: toggleRec }, h("i"));
  const timer = h("span", { class: "sa-num", style: "min-width:58px" }, "0:00.0");
  const meter = h("div", { class: "sa-meter", title: T.meter }, h("i"), h("b"));
  const gainOut = h("output", { class: "sa-num" }, sdb(st.inGainDb));
  const gainIn = h("input", { type: "range", min: "-20", max: "24", step: "0.5", value: String(st.inGainDb), title: T.gainTitle,
    oninput: (e) => {
      st.inGainDb = Number(e.target.value);
      gainOut.textContent = sdb(st.inGainDb);
      if (st.inGain) st.inGain.gain.setTargetAtTime(dbLin(st.inGainDb), st.ac.currentTime, 0.02);
      localStorage.setItem(LS.gain, String(st.inGainDb));
    },
    ondblclick: (e) => { e.target.value = "0"; e.target.dispatchEvent(new Event("input")); } });
  const setBox = h("div", { class: "sa-set", hidden: true });
  const gearBtn = h("button", { class: "sa-ib", title: T.settings, html: SVG.gear, onclick: () => { setBox.hidden = !setBox.hidden; } });
  const status = h("span", { class: "ui-small ui-muted" });
  const toolsBox = h("div", { class: "sa-tools" });
  const clock = h("span", { class: "sa-num" });
  const outBox = h("div", { class: "sa-out" });

  function renderBar() {
    const live = !!st.recorder;
    recBtn.className = `sa-rec${live ? " sa-live" : ""}`;
    recBtn.title = live ? T.stop : T.record;
    if (!live) timer.textContent = "0:00.0";
    status.textContent = st.pending ? T.sending : "";
    renderSettings(); renderTools(); renderOut(); draw();
  }

  function renderSettings() {
    const live = !!st.recorder;
    const reopen = async () => { closeStream(); try { await openStream(); } catch (x) { showErr(x); } };
    setBox.replaceChildren(
      h("select", { class: "ui-select", disabled: live, style: "min-width:220px;max-width:100%",
        onchange: (e) => { st.mic = e.target.value; localStorage.setItem(LS.mic, st.mic); reopen(); } },
      ...(st.devices.some((d) => d.label)
        ? st.devices.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === st.mic }, d.label || T.mic(i + 1)))
        : [h("option", { value: "" }, T.defaultMic)])),
      st.stream ? "" : h("button", { class: "ui-btn ui-outline ui-sm", onclick: () => openStream().catch(showErr) }, T.enableMic),
      h("label", { class: "ui-row", style: "gap:6px" },
        h("input", { type: "checkbox", class: "ui-check", checked: !st.rawMic, disabled: live,
          onchange: (e) => { st.rawMic = !e.target.checked; localStorage.setItem(LS.raw, st.rawMic ? "1" : "0"); if (st.stream) reopen(); } }),
        T.processing),
      h("span", { class: "ui-spacer" }),
      h("button", { class: "ui-btn ui-ghost ui-sm", disabled: live, onclick: deleteProject }, ctx.icon("trash"), T.deleteRec));
  }

  function updateClock() {
    clock.textContent = st.range ? `${fmt(st.range[0])} → ${fmt(st.range[1])}` : `${fmt(st.head)} / ${fmt(totalLen())}`;
  }

  function renderTools() {
    const has = st.clips.length > 0, live = !!st.recorder;
    const ib = (svg, title, fn, off, cls = "") => h("button", { class: `sa-ib ${cls}`, title, disabled: off, html: svg, onclick: fn });
    toolsBox.replaceChildren(
      ib(st.play ? SVG.pause : SVG.play, T.play, togglePlay, !has || live),
      clock,
      ib(SVG.cut, T.split, () => splitAt(st.head), !clipAt(st.head) || live),
      ib(SVG.del, st.range ? T.delSel : T.delTake, deleteSomething, (!st.range && !st.sel) || live),
      ib(SVG.undo, T.undo, undo, !st.undo.length || live),
      ib(SVG.redo, T.redo, redo, !st.redo.length || live),
      h("span", { class: "ui-spacer sa-zoom" }),
      ib(SVG.zout, T.zoomOut, () => zoom(0.66), !has || st.pps == null, "sa-zoom"),
      ib(SVG.zin, T.zoomIn, () => zoom(1.5), !has, "sa-zoom"));
    updateClock();
    exportBtn.disabled = !has || st.pending > 0 || live || st.cur?.export?.state === "running";
  }

  function renderOut() {
    const ex = st.cur?.export || {};
    exportBtn.replaceChildren(ctx.icon("download"), ex.state === "running" ? T.exporting : h("span", {}, h("span", { class: "sa-export-label" }, T.export), "MP3"));
    exportBtn.disabled = !st.clips.length || st.pending > 0 || !!st.recorder || ex.state === "running";
    if (ex.state === "done") {
      outBox.replaceChildren(
        h("a", { href: raw(ex.file, ex.at, true) }, T.download),
        h("span", { class: "sa-num" }, `${fmt(ex.duration)} · ${(ex.size / 1e6).toFixed(1)} ${T.mb}`),
        h("code", {}, ex.file));
    } else if (ex.state === "error") {
      outBox.replaceChildren(h("span", { style: "color:var(--destructive)" }, ex.error));
    } else outBox.replaceChildren();
  }

  function renderMain() {
    if (!st.cur) {
      main.replaceChildren(h("div", { class: "ui-card ui-empty" },
        h("div", { class: "ui-icon-box ui-lg ui-neutral" }, ctx.icon("mic")),
        h("h2", { class: "ui-h2" }, T.none),
        h("p", { class: "ui-muted" }, T.noneHint),
        h("button", { class: "ui-btn", onclick: createProject }, ctx.icon("plus"), T.newRec)));
      return;
    }
    nameIn.value = st.cur.name;
    main.replaceChildren(h("div", { class: "ui-card ui-stack sa-card", style: "gap:14px" },
      h("div", { class: "ui-row" }, nameIn, status, exportBtn),
      h("div", { class: "sa-bar" }, recBtn, timer, meter, h("label", { class: "sa-gain" }, T.gain, gainIn, gainOut), gearBtn),
      setBox, tlWrap, toolsBox, outBox));
    renderBar();
    requestAnimationFrame(draw);
  }

  // ---------- keyboard + leave guard ----------
  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || e.target?.isContentEditable || !st.cur || !el.isConnected) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat && !st.recorder) togglePlay(); if (tag === "BUTTON") e.target.blur(); return; }
    if (mod || e.altKey || e.repeat) {
      if (st.recorder || !mod) return;
      if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "y") { e.preventDefault(); redo(); }
      return;
    }
    if (k === "r") { e.preventDefault(); toggleRec(); return; }
    if (st.recorder) return;
    if (k === "s") { e.preventDefault(); splitAt(st.head); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSomething(); }
    else if (k === "escape") { st.range = null; draw(); renderTools(); }
    else if (k === "home") { e.preventDefault(); stopPlay(); st.head = 0; tlWrap.scrollLeft = 0; draw(); updateClock(); }
    else if (k === "arrowleft" || k === "arrowright") {
      e.preventDefault();
      st.head = clamp(st.head + (k === "arrowleft" ? -1 : 1) * (e.shiftKey ? 5 : 0.5), 0, totalLen());
      if (st.play) playFrom(st.head); else { draw(); renderTools(); }
    }
  };
  const onLeave = (e) => { if (st.recorder || st.pending) { e.preventDefault(); e.returnValue = ""; } };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", onLeave);

  // ---------- start ----------
  renderList();
  renderMain();
  listDevices().then(() => st.cur && renderSettings());
  refreshList().then(() => {
    const last = localStorage.getItem(LS.last);
    if (last && st.projects.some((p) => p.id === last)) openProject(last);
  });

  return () => {
    if (st.recorder) stopRec();                    // the take still uploads (queue keeps running)
    if (st.saveT) { clearTimeout(st.saveT); saveNow(); }
    clearInterval(st.poll);
    clearInterval(colorTimer);
    stopPlay();
    ro.disconnect();
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onLeave);
    closeStream();
    setTimeout(() => st.ac?.close().catch(() => {}), 1500);
  };
}

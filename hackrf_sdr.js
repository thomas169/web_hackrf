
"use strict";

const STORAGE_KEYS = {
    input: "rf_input",
    convertIp: "rf_convert_ip",
    convertOp: "rf_convert_op",
    shiftLvl: "rf_shift_lvl",
    shiftDir: "rf_shift_dir",
    manchesterMode: "rf_manchester_mode",
    diffInit: "rf_diff_init",
    inputHeight: "rf_input_height",
    inputWidth: "rf_input_width"
};

// ── Constants ────────────────────────────────────────────────
const VENDOR_ID  = 0x1d50;
const PRODUCT_ID = 0x6089;

const REQ_SET_TRANSCEIVER_MODE = 1;
const REQ_SET_FREQ             = 16;
const REQ_SET_AMP_ENABLE       = 17;
const REQ_SET_LNA_GAIN         = 19;
const REQ_SET_VGA_GAIN         = 20;
const REQ_SAMPLE_RATE          = 6;

const FFT_SIZE = 1024;

// ── State ────────────────────────────────────────────────────
let device      = null;
let rxRunning   = false;
let smoothedRMS = 0;
let peakRMS     = 0;
let peakDecay   = 0;
let lastLog     = 0;

let iqHistory = [];
const IQ_TRANSFERS = 256;
let scopeGridCache = null;

// ── DOM ──────────────────────────────────────────────────────
const logEl       = document.getElementById("logEl");
const statusDot   = document.getElementById("statusDot");
const freqDisplay = document.getElementById("freqDisplay");
const meterFill   = document.getElementById("meterFill");
const meterVal    = document.getElementById("meterVal");
const rmsVal      = document.getElementById("rmsVal");
const peakVal     = document.getElementById("peakVal");

// ── Canvas setup ─────────────────────────────────────────────
const scopeCanvas = document.getElementById("scopeCanvas");
const fftCanvas   = document.getElementById("fftCanvas");
const wfCanvas    = document.getElementById("wfCanvas");

const scopeCtx = scopeCanvas.getContext("2d");
const fftCtx   = fftCanvas.getContext("2d");
const wfCtx    = wfCanvas.getContext("2d");

// offscreen waterfall image buffer (we scroll rows down)
let wfImageData = null;

// Setting -------------------------
function saveSettings()
{
    const inputBox = document.getElementById("binaryInput");

    localStorage.setItem(STORAGE_KEYS.input, inputBox.value);
    localStorage.setItem(STORAGE_KEYS.convertIp, document.getElementById("convertIp").value);
    localStorage.setItem(STORAGE_KEYS.convertOp,document.getElementById("convertOp").value);
    localStorage.setItem(STORAGE_KEYS.shiftLvl, document.getElementById("shiftLvl").value);
    localStorage.setItem(STORAGE_KEYS.shiftDir, document.getElementById("shiftDir").value);
    localStorage.setItem(STORAGE_KEYS.manchesterMode, document.getElementById("manchesterMode").value);
    localStorage.setItem(STORAGE_KEYS.diffInit, document.getElementById("diffInit").value);

    // remember textarea size
    localStorage.setItem(STORAGE_KEYS.inputHeight, inputBox.offsetHeight);
    localStorage.setItem(STORAGE_KEYS.inputWidth, inputBox.offsetWidth);
}

function loadSettings()
{
    const inputBox = document.getElementById("binaryInput");
    const input = localStorage.getItem(STORAGE_KEYS.input);

    if (input !== null && input.trim().length > 0) {
        inputBox.value = input;
    }

    setIfExists("convertIp", STORAGE_KEYS.convertIp);
    setIfExists("convertOp", STORAGE_KEYS.convertOp);
    setIfExists("shiftLvl", STORAGE_KEYS.shiftLvl);
    setIfExists("shiftDir", STORAGE_KEYS.shiftDir);
    setIfExists("manchesterMode", STORAGE_KEYS.manchesterMode);
    setIfExists("diffInit", STORAGE_KEYS.diffInit);

    restoreTextareaSize();
}

function setIfExists(elementId, storageKey)
{
    const value = localStorage.getItem(storageKey);

    if (value !== null) {
        document.getElementById(elementId).value = value;
    }
}


function resizeCanvases() {
  const plotsEl = document.querySelector(".plots");
  const w = plotsEl.clientWidth;

  scopeCanvas.width = w;
  fftCanvas.width   = w;

  const wfSection = wfCanvas.parentElement;
  wfCanvas.width  = w;
  wfCanvas.height = wfSection.clientHeight - 26; // minus title bar

  // rebuild waterfall buffer when size changes
  wfImageData = wfCtx.createImageData(wfCanvas.width, wfCanvas.height);
  wfImageData.data.fill(0);
  // set alpha to 255 for all
  for (let i = 3; i < wfImageData.data.length; i += 4) wfImageData.data[i] = 255;
}

window.addEventListener("resize", resizeCanvases);
setTimeout(resizeCanvases, 50);

// ── Waterfall palette (thermal: black→purple→blue→cyan→green→yellow→red) ──
function buildPalette() {
  const p = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r, g, b;
    if (t < 0.2) {
      // black → dark blue
      r = 0; g = 0; b = Math.round(t / 0.2 * 180);
    } else if (t < 0.4) {
      // dark blue → cyan
      const s = (t - 0.2) / 0.2;
      r = 0; g = Math.round(s * 220); b = 180;
    } else if (t < 0.6) {
      // cyan → green
      const s = (t - 0.4) / 0.2;
      r = 0; g = 220; b = Math.round((1 - s) * 180);
    } else if (t < 0.8) {
      // green → yellow
      const s = (t - 0.6) / 0.2;
      r = Math.round(s * 255); g = 220; b = 0;
    } else {
      // yellow → red
      const s = (t - 0.8) / 0.2;
      r = 255; g = Math.round((1 - s) * 220); b = 0;
    }
    p[i * 3]     = r;
    p[i * 3 + 1] = g;
    p[i * 3 + 2] = b;
  }
  return p;
}
const PALETTE = buildPalette();

// ── FFT (Cooley-Tukey radix-2) ───────────────────────────────
function fft(re, im) {
  const n = re.length;
  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j],           uIm = im[i + j];
        const vRe = re[i + j + len/2] * curRe - im[i + j + len/2] * curIm;
        const vIm = re[i + j + len/2] * curIm + im[i + j + len/2] * curRe;
        re[i + j]          = uRe + vRe;
        im[i + j]          = uIm + vIm;
        re[i + j + len/2]  = uRe - vRe;
        im[i + j + len/2]  = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
}

// Hann window
const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++)
  hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

// compute magnitude spectrum (dB), FFT-shifted
let spectrumSmooth = new Float32Array(FFT_SIZE).fill(-100);

function computeSpectrum(iq) {
  const n = Math.min(iq.length, FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let i = 0; i < n; i++) {
    re[i] = iq[i].i * hannWindow[i] / 128.0;
    im[i] = iq[i].q * hannWindow[i] / 128.0;
  }

  fft(re, im);

  // magnitude in dB, fftshift
  const mag = new Float32Array(FFT_SIZE);
  const half = FFT_SIZE / 2;
  for (let i = 0; i < FFT_SIZE; i++) {
    const shifted = (i + half) % FFT_SIZE;
    const m = Math.sqrt(re[shifted] * re[shifted] + im[shifted] * im[shifted]) / FFT_SIZE;
    mag[i] = 20 * Math.log10(m + 1e-10);
  }

  // smooth over time (IIR)
  const alpha = 0.25;
  for (let i = 0; i < FFT_SIZE; i++)
    spectrumSmooth[i] = spectrumSmooth[i] * (1 - alpha) + mag[i] * alpha;

  return spectrumSmooth;
}

// ── Draw IQ scope ────────────────────────────────────────────
function ensureScopeGrid(w, h) {
  if (scopeGridCache && scopeGridCache.width === w && scopeGridCache.height === h) return;
  scopeGridCache = document.createElement("canvas");
  scopeGridCache.width = w;
  scopeGridCache.height = h;
  const g = scopeGridCache.getContext("2d");
  g.strokeStyle = "#0d1f0d";
  g.lineWidth = 1;
  for (let x = 0; x < w; x += 50) {
    g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke();
  }
  for (let y = 0; y < h; y += 25) {
    g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke();
  }
  g.strokeStyle = "#1a3a1a";
  g.beginPath(); g.moveTo(0,h/2); g.lineTo(w,h/2); g.stroke();
}

function drawScope(iq) {
  const w = scopeCanvas.width, h = scopeCanvas.height;
  ensureScopeGrid(w, h);

  // blit cached grid instead of redrawing it
  scopeCtx.clearRect(0, 0, w, h);
  scopeCtx.drawImage(scopeGridCache, 0, 0);

  if (!iq.length) return;
  const midY  = h / 2;
  const scale = (h / 2 - 4) / 128;

  for (let ch = 0; ch < 2; ch++) {
    scopeCtx.strokeStyle = ch === 0 ? "#00ff88" : "rgba(0,229,255,0.7)";
    scopeCtx.lineWidth = 1;
    // single beginPath for entire channel — much faster than per-pixel paths
    scopeCtx.beginPath();
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor(x / w * iq.length);
      const s1 = Math.min(Math.floor((x + 1) / w * iq.length), iq.length);
      let mn = 127, mx = -128;
      for (let s = s0; s < s1; s++) {
        const v = ch === 0 ? iq[s].i : iq[s].q;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const y1 = midY - mx * scale;
      const y2 = midY - mn * scale;
      scopeCtx.moveTo(x + 0.5, y1);
      scopeCtx.lineTo(x + 0.5, y2 < y1 ? y1 + 1 : y2 + 1);
    }
    scopeCtx.stroke(); // one stroke call for all 800 bars
  }
}

// ── Draw FFT spectrum ────────────────────────────────────────
const DB_MIN = -90, DB_MAX = -10;

function drawSpectrum(mag) {
  const w = fftCanvas.width, h = fftCanvas.height;
  fftCtx.clearRect(0, 0, w, h);

  // grid
  fftCtx.strokeStyle = "#0d1f0d";
  fftCtx.lineWidth = 1;
  for (let x = 0; x < w; x += 50) {
    fftCtx.beginPath(); fftCtx.moveTo(x, 0); fftCtx.lineTo(x, h); fftCtx.stroke();
  }
  for (let db = DB_MIN; db <= DB_MAX; db += 10) {
    const y = h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h;
    fftCtx.beginPath(); fftCtx.moveTo(0, y); fftCtx.lineTo(w, y); fftCtx.stroke();
    fftCtx.fillStyle = "#2a4a2a";
    fftCtx.font = "9px Share Tech Mono";
    fftCtx.fillText(db + "dB", 2, y - 2);
  }

  // fill under curve
  const grad = fftCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0,   "rgba(0,255,136,0.5)");
  grad.addColorStop(0.5, "rgba(0,229,255,0.15)");
  grad.addColorStop(1,   "rgba(0,0,0,0)");

  fftCtx.beginPath();
  fftCtx.moveTo(0, h);
  for (let i = 0; i < FFT_SIZE; i++) {
    const x = (i / FFT_SIZE) * w;
    const norm = Math.max(0, Math.min(1, (mag[i] - DB_MIN) / (DB_MAX - DB_MIN)));
    const y = h - norm * h;
    fftCtx.lineTo(x, y);
  }
  fftCtx.lineTo(w, h);
  fftCtx.closePath();
  fftCtx.fillStyle = grad;
  fftCtx.fill();

  // spectrum line
  fftCtx.strokeStyle = "#00ff88";
  fftCtx.lineWidth = 1.5;
  fftCtx.beginPath();
  for (let i = 0; i < FFT_SIZE; i++) {
    const x = (i / FFT_SIZE) * w;
    const norm = Math.max(0, Math.min(1, (mag[i] - DB_MIN) / (DB_MAX - DB_MIN)));
    const y = h - norm * h;
    i === 0 ? fftCtx.moveTo(x, y) : fftCtx.lineTo(x, y);
  }
  fftCtx.stroke();
}

// ── Draw waterfall (scroll rows down) ───────────────────────
function drawWaterfall(mag) {
  if (!wfImageData) return;
  const w = wfCanvas.width, h = wfCanvas.height;
  if (w === 0 || h === 0) return;

  const data = wfImageData.data;

  // scroll: shift all rows DOWN by 1 (memmove rows 0..h-2 → rows 1..h-1)
  data.copyWithin(w * 4, 0, w * (h - 1) * 4);

  // write new top row from spectrum
  for (let x = 0; x < w; x++) {
    const bin = Math.floor(x / w * FFT_SIZE);
    const norm = Math.max(0, Math.min(1, (mag[bin] - DB_MIN) / (DB_MAX - DB_MIN)));
    const pi = Math.floor(norm * 255);
    const idx = x * 4;
    data[idx]     = PALETTE[pi * 3];
    data[idx + 1] = PALETTE[pi * 3 + 1];
    data[idx + 2] = PALETTE[pi * 3 + 2];
    data[idx + 3] = 255;
  }

  wfCtx.putImageData(wfImageData, 0, 0);
}

// ── Helpers ──────────────────────────────────────────────────
function log(msg, type = "ok") {
  const line = document.createElement("div");
  line.className = "line " + type;
  line.textContent = "[" + new Date().toISOString().substr(11,8) + "] " + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function iqDecode(buf) {
  const iq = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    iq.push({ i: (buf[i] << 24 >> 24), q: (buf[i+1] << 24 >> 24) });
  }
  return iq;
}

function rmsOf(iq) {
  let s = 0;
  for (const p of iq) s += p.i * p.i + p.q * p.q;
  return Math.sqrt(s / iq.length);
}

function smooth(v) {
  smoothedRMS = smoothedRMS * 0.88 + v * 0.12;
  return smoothedRMS;
}

function updateMeters(r) {
  // peak hold
  if (r > peakRMS) { peakRMS = r; peakDecay = 80; }
  else if (peakDecay-- <= 0) peakRMS = Math.max(peakRMS * 0.98, 0);

  const pct = Math.min(100, (r / 60) * 100);
  meterFill.style.width = pct + "%";
  const db = r > 0 ? (20 * Math.log10(r / 128)).toFixed(1) : "--";
  meterVal.textContent  = db + " dB";
  rmsVal.textContent    = r.toFixed(2);
  peakVal.textContent   = peakRMS.toFixed(2);
}

function updateFreqDisplay() {
  const hz = parseFloat(document.getElementById("freq").value) || 0;
  freqDisplay.innerHTML = (hz / 1e6).toFixed(3) + '<span class="freq-unit">MHz</span>';
}
document.getElementById("freq").addEventListener("input", updateFreqDisplay);
updateFreqDisplay();

// ── USB / HackRF ─────────────────────────────────────────────
function packFreq(freqHz) {
  const mhz = Math.floor(freqHz / 1_000_000);
  const hz  = freqHz % 1_000_000;
  const buf = new ArrayBuffer(8);
  const v   = new DataView(buf);
  v.setUint32(0, mhz, true);
  v.setUint32(4, hz,  true);
  return buf;
}

function packSampleRate(hz, div = 1) {
  const buf = new ArrayBuffer(8);
  const v   = new DataView(buf);
  v.setUint32(0, hz,  true);
  v.setUint32(4, div, true);
  return buf;
}

function packLnaGain(lna) {
  lna = Math.max(0, Math.min(40, lna));
  return lna & ~0x7;
}

function packVgaGain(vga) {
  vga = Math.max(0, Math.min(62, vga));
  return vga & ~0x1;
}

async function connectHackRF() {
  try {
    device = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    log("Device: " + device.productName, "info");
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
    await device.selectAlternateInterface(0, 0);
    statusDot.classList.add("active");
    log("Connected", "ok");
  } catch (e) { log("Connect failed: " + e, "err"); }
}

async function configureHackRF(freqHz, srHz, lna, vga, amp) {
  const D = 100;

  // mode off
  await device.controlTransferOut({
    requestType:"vendor", recipient:"device",
    request: REQ_SET_TRANSCEIVER_MODE, value: 0, index: 0
  }, new Uint8Array(0));

  // LNA
  let res = await device.controlTransferIn({
    requestType:"vendor", recipient:"device",
    request: REQ_SET_LNA_GAIN, value: 0, index: packLnaGain(lna)
  }, 1);
  if (res.status !== "ok") throw new Error("LNA failed");
  log("LNA=" + packLnaGain(lna));
  await sleep(D);

  // VGA
  res = await device.controlTransferIn({
    requestType:"vendor", recipient:"device",
    request: REQ_SET_VGA_GAIN, value: 0, index: packVgaGain(vga)
  }, 1);
  if (res.status !== "ok") throw new Error("VGA failed");
  log("VGA=" + packVgaGain(vga));
  await sleep(D);

  // Freq
  await device.controlTransferOut({
    requestType:"vendor", recipient:"device",
    request: REQ_SET_FREQ, value: 0, index: 0
  }, new Uint8Array(packFreq(freqHz)));
  log("FREQ=" + (freqHz/1e6).toFixed(3) + "MHz");
  await sleep(D);

  // Sample rate
  await device.controlTransferOut({
    requestType:"vendor", recipient:"device",
    request: REQ_SAMPLE_RATE, value: 0, index: 0
  }, new Uint8Array(packSampleRate(srHz)));
  log("SR=" + (srHz/1e6) + "MHz");
  await sleep(D);

  // Amp
  res = await device.controlTransferOut({
    requestType:"vendor", recipient:"device",
    request: REQ_SET_AMP_ENABLE, value: amp ? 1 : 0, index: 0
  });
  if (res.status !== "ok") throw new Error("AMP failed");
  log("AMP=" + (amp ? "ON" : "OFF"));
  await sleep(D);
}

async function startRX() {
  if (!device) { log("Not connected", "err"); return; }
  if (rxRunning) return;
  try {
    log("Configuring...", "info");
    const freqHz = parseFloat(document.getElementById("freq").value);
    const srHz   = parseInt(document.getElementById("samplerate").value);
    const lna    = parseInt(document.getElementById("lna").value);
    const vga    = parseInt(document.getElementById("vga").value);
    const amp    = parseInt(document.getElementById("amp").value);
    await configureHackRF(freqHz, srHz, lna, vga, amp);

    await device.controlTransferOut({
      requestType:"vendor", recipient:"device",
      request: REQ_SET_TRANSCEIVER_MODE, value: 1, index: 0
    }, new Uint8Array(0));

    log("RX ON", "ok");
    rxRunning = true;
    readLoop();
  } catch(e) { log("Start failed: " + e, "err"); }
}

async function stopRX() {
  if (!device) return;
  rxRunning = false;
  try {
    await device.controlTransferOut({
      requestType:"vendor", recipient:"device",
      request: REQ_SET_TRANSCEIVER_MODE, value: 0, index: 0
    }, new Uint8Array(0));
    statusDot.classList.remove("active");
    log("RX OFF", "info");
  } catch(e) { log("Stop failed: " + e, "err"); }
}

async function readLoop() {
  log("Read loop started", "info");
  
  while (rxRunning) {
    const result = await device.transferIn(1, 16384);
    if (!rxRunning) break;
    if (result.status !== "ok" || !result.data) continue;

    const raw = new Uint8Array(result.data.buffer);
    const iq  = iqDecode(raw);
    const r   = smooth(rmsOf(iq));
    const mag = computeSpectrum(iq);

    iqHistory.push(...iq);
    const maxSamples = (16384 / 2) * IQ_TRANSFERS;
    if (iqHistory.length > maxSamples) iqHistory.splice(0, iqHistory.length - maxSamples);
    
    drawScope(iqHistory);
    drawSpectrum(mag);
    drawWaterfall(mag);
    updateMeters(r);
  }
  log("Read loop stopped", "info");
}

document.getElementById("connectBtn").addEventListener("click", connectHackRF);
document.getElementById("startBtn").addEventListener("click", startRX);
document.getElementById("stopBtn").addEventListener("click", stopRX);
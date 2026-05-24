"use strict";

import { ISDRDevice } from "./devices/interface.js";
import { IQSample } from "./common/types.js";

import { HackRF } from "./devices/hackrf.js";
import { RTLSDRDevice } from "./devices/rtlsdr.js";

// ── Constants ────────────────────────────────────────────────
const FFT_SIZE = 1024;

const RX_JOB_SIZE    = 8;
const CHUNK_BYTES    = 262144;
const BYTES_PER_SAMPLE = 2;
const SAMPLE_RATE    = 10e6;
const CHUNK_DURATION_MS = (CHUNK_BYTES / BYTES_PER_SAMPLE) / SAMPLE_RATE * 1000;


type ValidBandwidth = 1750000 | 2500000 | 3500000 | 5000000 | 5500000
    | 6000000 | 7000000 | 8000000 | 9000000 | 10000000
    | 12000000 | 14000000 | 15000000 | 20000000 | 24000000 | 28000000;

const MAX2837_FT: ValidBandwidth[] = [
    1750000, 2500000, 3500000, 5000000, 5500000,
    6000000, 7000000, 8000000, 9000000, 10000000,
    12000000, 14000000, 15000000, 20000000, 24000000, 28000000
];


interface SaveElements {
    device_type: HTMLSelectElement;
    freq:        HTMLInputElement;
    samplerate:  HTMLSelectElement;
    bw:          HTMLSelectElement;
    lna:         HTMLInputElement;
    vga:         HTMLInputElement;
    amp:         HTMLSelectElement;
}

// ── State ────────────────────────────────────────────────────
let device:      USBDevice | null = null;
declare const RtlSdr: any;
let sdr: ISDRDevice | null = null;


let rxRunning:   boolean          = false;
let smoothedRMS: number           = 0;
let peakRMS:     number           = 0;
let peakDecay:   number           = 0;

let iqHistory: IQSample[] = [];
const IQ_TRANSFERS = 1;
let scopeGridCache: HTMLCanvasElement | null = null;

let isRecording = false;
let recChunks:   Uint8Array[] = [];

let tpsCount    = 0;
let tpsLastTime = 0;
let tpsRate     = 0;

// ── DOM ──────────────────────────────────────────────────────
const logEl       = document.getElementById("logEl")       as HTMLDivElement;
const statusDot   = document.getElementById("statusDot")   as HTMLDivElement;
const freqDisplay = document.getElementById("freqDisplay") as HTMLDivElement;
const meterFill   = document.getElementById("meterFill")   as HTMLDivElement;
const meterVal    = document.getElementById("meterVal")    as HTMLDivElement;
const rmsVal      = document.getElementById("rmsVal")      as HTMLDivElement;
const peakVal     = document.getElementById("peakVal")     as HTMLDivElement;
const recBtn      = document.getElementById("recBtn")      as HTMLButtonElement;

// ── Canvas ───────────────────────────────────────────────────
const scopeCanvas = document.getElementById("scopeCanvas") as HTMLCanvasElement;
const fftCanvas   = document.getElementById("fftCanvas")   as HTMLCanvasElement;
const wfCanvas    = document.getElementById("wfCanvas")    as HTMLCanvasElement;

const scopeCtx = scopeCanvas.getContext("2d") as CanvasRenderingContext2D;
const fftCtx   = fftCanvas.getContext("2d")   as CanvasRenderingContext2D;
const wfCtx    = wfCanvas.getContext("2d")    as CanvasRenderingContext2D;

// ── Save elements ────────────────────────────────────────────
const save_elements: SaveElements = {
    device_type: document.getElementById("device_type") as HTMLSelectElement,
    freq:        document.getElementById("freq")        as HTMLInputElement,
    samplerate:  document.getElementById("samplerate")  as HTMLSelectElement,
    bw:          document.getElementById("bw")          as HTMLSelectElement,
    lna:         document.getElementById("lna")         as HTMLInputElement,
    vga:         document.getElementById("vga")         as HTMLInputElement,
    amp:         document.getElementById("amp")         as HTMLSelectElement,
};

// ── Meters ───────────────────────────────────────────────────
const dom_tps_val  = document.getElementById("tpsVal")  as HTMLDivElement;
const dom_tps_fill = document.getElementById("tpsFill") as HTMLDivElement;
const dom_mbs_val  = document.getElementById("mbsVal")  as HTMLDivElement;

const DB_MIN = -90;
const DB_MAX = 10;

let wfImageData: ImageData | null = null;

// ── Storage ──────────────────────────────────────────────────
const STORAGE_PREFIX = "store_";
const storageKey = (id: string): string => STORAGE_PREFIX + id;

function saveSettings(): void {
    for (const el of Object.values(save_elements)) {
        if (el?.id) localStorage.setItem(storageKey(el.id), el.value);
    }
}

function loadSettings(): void {
    for (const el of Object.values(save_elements)) {
        if (!el?.id) continue;
        const val = localStorage.getItem(storageKey(el.id));
        if (val !== null) el.value = val;
    }
}


function update_connect_button(): void {
    const btn = document.getElementById("connectBtn");
    if (!btn) return;
    btn.textContent = sdr ? "DISCONNECT" : "CONNECT";
}

// ── Canvas resize ────────────────────────────────────────────
function resizeCanvases(): void {
    const plotsEl = document.querySelector(".plots") as HTMLElement;
    const w = plotsEl.clientWidth;

    scopeCanvas.width = w;
    fftCanvas.width   = w;

    const wfSection = wfCanvas.parentElement as HTMLElement;
    wfCanvas.width  = w;
    wfCanvas.height = wfSection.clientHeight - 26;

    wfImageData = wfCtx.createImageData(wfCanvas.width, wfCanvas.height);
    wfImageData.data.fill(0);
    for (let i = 3; i < wfImageData.data.length; i += 4) wfImageData.data[i] = 255;
}

window.addEventListener("resize", resizeCanvases);
setTimeout(resizeCanvases, 50);
loadSettings();

// ── Waterfall palette ────────────────────────────────────────
function buildPalette(): Uint8Array {
    const p = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r: number, g: number, b: number;
        if (t < 0.2) {
            r = 0; g = 0; b = Math.round(t / 0.2 * 180);
        } else if (t < 0.4) {
            const s = (t - 0.2) / 0.2;
            r = 0; g = Math.round(s * 220); b = 180;
        } else if (t < 0.6) {
            const s = (t - 0.4) / 0.2;
            r = 0; g = 220; b = Math.round((1 - s) * 180);
        } else if (t < 0.8) {
            const s = (t - 0.6) / 0.2;
            r = Math.round(s * 255); g = 220; b = 0;
        } else {
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

// ── TPS meter ────────────────────────────────────────────────
function updateTPS(): void {
    const now = performance.now();
    tpsCount++;
    if (now - tpsLastTime >= 500) {
        const elapsed = (now - tpsLastTime) / 1000;
        tpsRate = tpsCount / elapsed;
        const mbps = (tpsRate * CHUNK_BYTES) / 1e6;
        const maxTps = 1000 / (CHUNK_BYTES / BYTES_PER_SAMPLE / SAMPLE_RATE * 1000);
        dom_tps_val.textContent = tpsRate.toFixed(1) + " /s";
        dom_mbs_val.textContent = mbps.toFixed(2) + " MB/s";
        dom_tps_fill.style.width = Math.min(100, tpsRate / maxTps * 100) + "%";
        tpsCount = 0;
        tpsLastTime = now;
    }
}

// ── FFT ──────────────────────────────────────────────────────
function fft(re: Float32Array, im: Float32Array): void {
    const n = re.length;
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
                const uRe = re[i + j], uIm = im[i + j];
                const vRe = re[i + j + len/2] * curRe - im[i + j + len/2] * curIm;
                const vIm = re[i + j + len/2] * curIm + im[i + j + len/2] * curRe;
                re[i + j]         = uRe + vRe;
                im[i + j]         = uIm + vIm;
                re[i + j + len/2] = uRe - vRe;
                im[i + j + len/2] = uIm - vIm;
                const nr = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nr;
            }
        }
    }
}

const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
}

let spectrumSmooth = new Float32Array(FFT_SIZE).fill(-100);

function computeSpectrum(iq: IQSample[]): Float32Array {
    const n  = Math.min(iq.length, FFT_SIZE);
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);

    for (let i = 0; i < n; i++) {
        re[i] = iq[i].i * hannWindow[i] / 128.0;
        im[i] = iq[i].q * hannWindow[i] / 128.0;
    }

    fft(re, im);

    const mag  = new Float32Array(FFT_SIZE);
    const half = FFT_SIZE / 2;
    for (let i = 0; i < FFT_SIZE; i++) {
        const shifted = (i + half) % FFT_SIZE;
        const m = Math.sqrt(re[shifted] ** 2 + im[shifted] ** 2) / FFT_SIZE;
        mag[i]  = 20 * Math.log10(m + 1e-10);
    }

    const alpha = 0.25;
    for (let i = 0; i < FFT_SIZE; i++)
        spectrumSmooth[i] = spectrumSmooth[i] * (1 - alpha) + mag[i] * alpha;

    return spectrumSmooth;
}

// ── Scope ────────────────────────────────────────────────────
function ensureScopeGrid(w: number, h: number): void {
    if (scopeGridCache?.width === w && scopeGridCache?.height === h) return;
    scopeGridCache = document.createElement("canvas");
    scopeGridCache.width  = w;
    scopeGridCache.height = h;
    const g = scopeGridCache.getContext("2d") as CanvasRenderingContext2D;
    g.strokeStyle = "#0d1f0d";
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 50) { g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke(); }
    for (let y = 0; y < h; y += 25) { g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke(); }
    g.strokeStyle = "#1a3a1a";
    g.beginPath(); g.moveTo(0, h/2); g.lineTo(w, h/2); g.stroke();
}

function drawScope(iq: IQSample[]): void {
    const w = scopeCanvas.width, h = scopeCanvas.height;
    ensureScopeGrid(w, h);
    scopeCtx.clearRect(0, 0, w, h);
    scopeCtx.drawImage(scopeGridCache!, 0, 0);

    if (!iq.length) return;
    const midY  = h / 2;
    const scale = (h / 2 - 4) / 128;

    for (let ch = 0; ch < 2; ch++) {
        scopeCtx.strokeStyle = ch === 0 ? "#00ff88" : "rgba(0,229,255,0.7)";
        scopeCtx.lineWidth = 1;
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
        scopeCtx.stroke();
    }
}

// ── Spectrum ─────────────────────────────────────────────────
function drawSpectrum(mag: Float32Array): void {
    const w = fftCanvas.width, h = fftCanvas.height;
    fftCtx.clearRect(0, 0, w, h);

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

    const grad = fftCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0,   "rgba(0,255,136,0.5)");
    grad.addColorStop(0.5, "rgba(0,229,255,0.15)");
    grad.addColorStop(1,   "rgba(0,0,0,0)");

    fftCtx.beginPath();
    fftCtx.moveTo(0, h);
    for (let i = 0; i < FFT_SIZE; i++) {
        const x    = (i / FFT_SIZE) * w;
        const norm = Math.max(0, Math.min(1, (mag[i] - DB_MIN) / (DB_MAX - DB_MIN)));
        fftCtx.lineTo(x, h - norm * h);
    }
    fftCtx.lineTo(w, h);
    fftCtx.closePath();
    fftCtx.fillStyle = grad;
    fftCtx.fill();

    fftCtx.strokeStyle = "#00ff88";
    fftCtx.lineWidth = 1.5;
    fftCtx.beginPath();
    for (let i = 0; i < FFT_SIZE; i++) {
        const x    = (i / FFT_SIZE) * w;
        const norm = Math.max(0, Math.min(1, (mag[i] - DB_MIN) / (DB_MAX - DB_MIN)));
        i === 0 ? fftCtx.moveTo(x, h - norm * h) : fftCtx.lineTo(x, h - norm * h);
    }
    fftCtx.stroke();
}

// ── Waterfall ────────────────────────────────────────────────
function drawWaterfall(mag: Float32Array): void {
    if (!wfImageData) return;
    const w = wfCanvas.width, h = wfCanvas.height;
    if (w === 0 || h === 0) return;

    const data = wfImageData.data;
    data.copyWithin(w * 4, 0, w * (h - 1) * 4);

    for (let x = 0; x < w; x++) {
        const bin  = Math.floor(x / w * FFT_SIZE);
        const norm = Math.max(0, Math.min(1, (mag[bin] - DB_MIN) / (DB_MAX - DB_MIN)));
        const pi   = Math.floor(norm * 255);
        const idx  = x * 4;
        data[idx]     = PALETTE[pi * 3];
        data[idx + 1] = PALETTE[pi * 3 + 1];
        data[idx + 2] = PALETTE[pi * 3 + 2];
        data[idx + 3] = 255;
    }

    wfCtx.putImageData(wfImageData, 0, 0);
}


// ── Recording ────────────────────────────────────────────────
function toggleRecord(): void {
    if (!rxRunning) { log("Start RX first", "err"); return; }
    if (!isRecording) {
        recChunks   = [];
        isRecording = true;
        recBtn.textContent = "STOP REC";
        recBtn.classList.add("active");
        log("Recording IQ...", "info");
    } else {
        isRecording = false;
        recBtn.textContent = "REC IQ";
        recBtn.classList.remove("active");
        saveIQ();
    }
}

function saveIQ(): void {
    if (!recChunks.length) { log("Nothing recorded", "err"); return; }
    const total = recChunks.reduce((s, c) => s + c.length, 0);
    const out   = new Uint8Array(total);
    let offset  = 0;
    for (const c of recChunks) { out.set(c, offset); offset += c.length; }
    recChunks = [];

    const blob = new Blob([out], { type: "application/octet-stream" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "hackrf_" + Date.now() + ".bin";
    a.click();
    URL.revokeObjectURL(url);
    log(`Saved ${(total / 1e6).toFixed(2)} MB (${total / 2} samples)`, "ok");
}

// ── Helpers ──────────────────────────────────────────────────
function log(msg: string, type: "ok" | "err" | "info" = "ok"): void {
    const line = document.createElement("div");
    line.className   = "line " + type;
    line.textContent = "[" + new Date().toISOString().substr(11, 8) + "] " + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function rmsOf(iq: IQSample[]): number {
    let s = 0;
    for (const p of iq) s += p.i * p.i + p.q * p.q;
    return Math.sqrt(s / iq.length);
}

function smooth(v: number): number {
    smoothedRMS = smoothedRMS * 0.88 + v * 0.12;
    return smoothedRMS;
}

function updateMeters(r: number): void {
    if (r > peakRMS) { peakRMS = r; peakDecay = 80; }
    else if (peakDecay-- <= 0) peakRMS = Math.max(peakRMS * 0.98, 0);

    const pct = Math.min(100, (r / 60) * 100);
    meterFill.style.width = pct + "%";
    const db = r > 0 ? (20 * Math.log10(r / 128)).toFixed(1) : "--";
    meterVal.textContent = db + " dB";
    rmsVal.textContent   = r.toFixed(2);
    peakVal.textContent  = peakRMS.toFixed(2);
}

function updateFreqDisplay(): void {
    const hz = parseFloat(save_elements.freq.value) || 0;
    freqDisplay.innerHTML = (hz / 1e6).toFixed(3) + '<span class="freq-unit">MHz</span>';
}
save_elements.freq.addEventListener("input", updateFreqDisplay);
updateFreqDisplay();



async function readLoop(): Promise<void> {
    log("Read loop started", "info");

    const transfer = async (): Promise<void> => {
        while (rxRunning && sdr) {
            const result = await sdr.read(CHUNK_BYTES);
            if (!rxRunning) break;
            if (!result) continue;
            const iq = sdr.parse(result);
            const r = smooth(rmsOf(iq));

            if (isRecording) recChunks.push(new Uint8Array(result));

            for (let i = 0; i < iq.length; i++) iqHistory.push(iq[i]);
            const maxSamples = (CHUNK_BYTES / BYTES_PER_SAMPLE) * IQ_TRANSFERS;
            if (iqHistory.length > maxSamples) iqHistory.splice(0, iqHistory.length - maxSamples);

            updateMeters(r);
            updateTPS();
        }
    };

    const drawLoop = async (): Promise<void> => {
        while (rxRunning) {
            await new Promise<void>(r => requestAnimationFrame(() => r()));
            if (!rxRunning) break;
            const mag = computeSpectrum(iqHistory.slice(-FFT_SIZE));
            drawScope(iqHistory);
            drawSpectrum(mag);
            drawWaterfall(mag);
        }
    };

    Array.from({ length: RX_JOB_SIZE }, transfer)
        .forEach(p => p.catch((e: unknown) => log("Transfer error: " + e, "err")));
    
    drawLoop().catch((e: unknown) => log("Draw error: " + e, "err"));

    log(`RX loop started (${RX_JOB_SIZE} transfers)`, "info");
}



async function connect_device(): Promise<void>{
    try {
        if (sdr) {
            if (rxRunning) {
                await stop_rx_device();
            }
            await sdr.disconnect();
            sdr = null;
            update_connect_button();
            log("Disconnected", "info");
            return;
        }

        const type = save_elements.device_type.value;

        switch (type) {
            case "hackrf":
                sdr = new HackRF();
                break;
            case "rtlsdr":
                sdr = new RTLSDRDevice();
                break;
            default:
                throw new Error("unknown device");
        }

        await sdr.connect();
        update_connect_button();
        log("Connected", "ok");
    } catch (e) {
        console.error(e);
        log("Connect failed", "err");
    }
}

async function start_rx_device() {
    if (!sdr) return;
    if (rxRunning) return;

    tpsCount = 0;
    tpsLastTime = performance.now();

    log("Configuring...", "info");

    const freqHz = parseFloat(save_elements.freq.value);
    const srHz = parseInt(save_elements.samplerate.value);
    const lna = parseInt(save_elements.lna.value);
    const vga = parseInt(save_elements.vga.value);
    const amp = parseInt(save_elements.amp.value);
    const bw = parseInt(save_elements.bw.value);
       
    await sdr.set_param("amp", amp as unknown as boolean);
    await sdr.set_param("bw", bw);
    await sdr.set_param("frequency", freqHz);
    await sdr.set_param("sample_rate", srHz);
    await sdr.set_param("lna", lna);
    await sdr.set_param("vga", vga);

    await sdr.start_rx();

    log("RX ON", "ok");

    rxRunning = true;
    void readLoop();

}

async function stop_rx_device() {
    if (!sdr) return;
    rxRunning = false;
    await sdr.stop_rx();
}

async function update_param(name: string) {
    saveSettings();
    if (!sdr) return;
    const restart_rx = rxRunning;
    
    if (rxRunning) {
        await sdr.stop_rx();
    }

    const freqHz = parseFloat(save_elements.freq.value);
    const srHz = parseInt(save_elements.samplerate.value);
    const lna = parseInt(save_elements.lna.value);
    const vga = parseInt(save_elements.vga.value);
    const amp = parseInt(save_elements.amp.value) as unknown as boolean;
    const bw = parseInt(save_elements.bw.value);
    const gain = 0;

    switch (name) {
        case "sample_rate":
            await sdr.set_param("amp", srHz);
            break;
        case "frequency":
            await sdr.set_param("frequency", freqHz);
            break;
        case "amp":
            await sdr.set_param("amp", amp);
            break;
        case "lna":
            await sdr.set_param("lna", lna);
            break;
        case "vga":
            await sdr.set_param("vga", vga);
            break;
        case "gain":
            await sdr.set_param("gain", gain);
            break;
        case "bw":
            await sdr.set_param("bw", bw);
            break;
    }
    if (restart_rx) {
        await sdr.start_rx();
    }
}

// ── Event listeners ──────────────────────────────────────────
document.getElementById("connectBtn")!.addEventListener("click", connect_device);
document.getElementById("startBtn")!.addEventListener("click", start_rx_device);
document.getElementById("stopBtn")!.addEventListener("click", stop_rx_device);
document.getElementById("recBtn")!.addEventListener("click", toggleRecord);

save_elements.freq.addEventListener("change", () => update_param("frequency"));
save_elements.samplerate.addEventListener("change",  () => update_param("sample_rate"));
save_elements.bw.addEventListener("change",  () => update_param("bw"));
save_elements.lna.addEventListener("change",  () => update_param("lna"));
save_elements.vga.addEventListener("change",  () => update_param("vga"));
save_elements.amp.addEventListener("change",  () => update_param("amp"));

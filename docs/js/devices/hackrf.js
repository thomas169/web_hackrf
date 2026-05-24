"use strict";
import { int8val, uint32, uint16 } from "../common/types.js";
// ── Constants ────────────────────────────────────────────────
const VENDOR_ID = 0x1d50;
const PRODUCT_ID = 0x6089;
const REQ_SET_TRANSCEIVER_MODE = 1;
const REQ_SAMPLE_RATE = 6;
const REQ_SET_BW = 7;
const REQ_SET_FREQ = 16;
const REQ_SET_AMP_ENABLE = 17;
const REQ_SET_LNA_GAIN = 19;
const REQ_SET_VGA_GAIN = 20;
const MAX2837_FT = [
    1750000, 2500000, 3500000, 5000000, 5500000,
    6000000, 7000000, 8000000, 9000000, 10000000,
    12000000, 14000000, 15000000, 20000000, 24000000, 28000000
];
function packFreq(freqHz) {
    const f = uint32(freqHz); // validate + brand once here
    const mhz = uint32(Math.floor(f / 1000000));
    const hz = uint32(f % 1000000);
    const buf = new ArrayBuffer(8);
    const v = new DataView(buf);
    v.setUint32(0, mhz, true);
    v.setUint32(4, hz, true);
    return buf;
}
function packSampleRate(hz, div = 1) {
    const h = uint32(hz);
    const d = uint32(div);
    const buf = new ArrayBuffer(8);
    const v = new DataView(buf);
    v.setUint32(0, h, true);
    v.setUint32(4, d, true);
    return buf;
}
function packLnaGain(lna) {
    const clamped = Math.max(0, Math.min(40, lna));
    return uint16(clamped & ~0x7);
}
function packVgaGain(vga) {
    const clamped = Math.max(0, Math.min(62, vga));
    return uint16(clamped & ~0x1);
}
function computeBasebandFilterBw(bw) {
    const i = MAX2837_FT.findIndex(e => e >= bw);
    if (i === -1)
        return MAX2837_FT[MAX2837_FT.length - 1];
    return i > 0 ? MAX2837_FT[i - 1] : MAX2837_FT[0];
}
// ── Main class ──────────────────────────────────────────────
export class HackRF {
    constructor() {
        this.active = false;
    }
    get_supported_params() {
        return ["lna", "vga", "amp", "bw", "sample_rate", "frequency"];
    }
    // ── connect ─────────────────────────────
    async connect() {
        if (this.device) {
            await this.disconnect();
        }
        this.device = await navigator.usb.requestDevice({
            filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]
        });
        await this.device.open();
        if (this.device.configuration === null)
            await this.device.selectConfiguration(1);
        await this.device.claimInterface(0);
        await this.device.selectAlternateInterface(0, 0);
    }
    async set_frequency(freq) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_FREQ,
            value: 0,
            index: 0
        }, packFreq(freq));
    }
    async set_sample_rate(rate) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SAMPLE_RATE,
            value: 0,
            index: 0
        }, packSampleRate(rate));
    }
    async set_lna(gain) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        await this.device.controlTransferIn({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_LNA_GAIN,
            value: 0,
            index: packLnaGain(gain)
        }, 1);
    }
    async set_vga(gain) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        await this.device.controlTransferIn({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_VGA_GAIN,
            value: 0,
            index: packVgaGain(gain)
        }, 1);
    }
    async set_bw(freq) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        if (freq === 0) {
            // 10e6 is default sample rate
            freq = computeBasebandFilterBw(0.75 * 10e6);
        }
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_BW,
            value: freq & 0xffff,
            index: (freq >> 16) & 0xffff
        });
    }
    async set_amp(active) {
        if (!this.device) {
            throw new Error("HackRF not connected");
        }
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_AMP_ENABLE,
            value: active ? 1 : 0,
            index: 0
        });
    }
    async set_param(name, value) {
        const needs_reset = this.active;
        if (needs_reset)
            await this.stop_rx();
        switch (name) {
            case "frequency":
                await this.set_frequency(value);
                break;
            case "sample_rate":
                await this.set_sample_rate(value);
                break;
            case "lna":
                await this.set_lna(value);
                break;
            case "vga":
                await this.set_vga(value);
                break;
            case "bw":
                await this.set_bw(value);
                break;
            case "amp":
                await this.set_amp(value);
                break;
            default:
                throw new Error("Unsupported parameter: ${name}");
        }
        if (needs_reset)
            await this.start_rx();
    }
    // ── RX start ────────────────────────────
    async start_rx() {
        if (!this.device)
            throw new Error("not connected");
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_TRANSCEIVER_MODE,
            value: 1,
            index: 0
        }, new Uint8Array(0));
        this.active = true;
    }
    // ── RX stop ─────────────────────────────
    async stop_rx() {
        if (!this.device)
            return;
        await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "device",
            request: REQ_SET_TRANSCEIVER_MODE,
            value: 0,
            index: 0
        }, new Uint8Array(0));
        this.active = false;
    }
    // ── disconnect ──────────────────────────
    async disconnect() {
        if (!this.device)
            return;
        await this.stop_rx();
        await this.device.close();
    }
    // ── parse ──────────────────────────
    parse(buf) {
        const iq = [];
        for (let i = 0; i + 1 < buf.length; i += 2) {
            iq.push({
                i: int8val(buf[i] << 24 >> 24),
                q: int8val(buf[i + 1] << 24 >> 24)
            });
        }
        return iq;
    }
    // ── read ──────────────────────────
    async read(length) {
        if (!this.device || !length)
            return null;
        const result = await this.device.transferIn(1, length);
        if (!result.data)
            return null;
        return new Uint8Array(result.data.buffer);
    }
}

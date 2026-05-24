import { int8val } from "../common/types.js";
export class RTLSDRDevice {
    constructor() {
        this.sdr = null;
    }
    async connect() {
        this.sdr = await RtlSdr.requestDevice();
        await this.sdr.open({
            ppm: 0,
            gain: null
        });
        await this.sdr.setSampleRate(2e6);
        await this.sdr.setCenterFrequency(434e6);
        await this.sdr.resetBuffer();
    }
    get_supported_params() {
        return ["gain", "bw", "sample_rate", "frequency"];
    }
    async set_frequency(freq) {
        await this.sdr.setCenterFrequency(freq);
    }
    async set_sample_rate(rate) {
        await this.sdr.setSampleRate(rate);
    }
    async set_gain(gain) {
        //this.sdr.setGain(gain);
    }
    async set_bw(freq) {
        //this.sdr.setGain(freq);
    }
    async set_param(name, value) {
        switch (name) {
            case "frequency":
                await this.set_frequency(value);
                break;
            case "sample_rate":
                await this.set_sample_rate(value);
                break;
            case "gain":
                //await this.set_gain(value as number);
                break;
            case "bw":
                //await this.set_bw(value as number);
                break;
            default:
            //throw new Error("Unsupported parameter: ${name}" );
        }
    }
    async disconnect() {
        if (this.sdr) {
            await this.sdr.close();
            this.sdr = null;
        }
    }
    async start_rx() {
        await this.sdr.resetBuffer();
    }
    stop_rx() {
        // stub 
    }
    async read(length = 16 * 16384) {
        try {
            const result = await this.sdr.readSamples(length);
            return new Uint8Array(result);
        }
        catch (err) {
            console.error(err);
            return null;
        }
    }
    parse(raw) {
        const iq = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
            iq.push({
                i: int8val(raw[i] - 128),
                q: int8val(raw[i + 1] - 128)
            });
        }
        return iq;
    }
}

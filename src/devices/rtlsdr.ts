
declare const RtlSdr: any;

import { ISDRDevice } from "./interface.js";
import { IQSample, int8val, SDRParamValue} from "../common/types.js";

export class RTLSDRDevice implements ISDRDevice
{
    private sdr: any = null;

    async connect(): Promise<void>
    {
        this.sdr = await RtlSdr.requestDevice();

        await this.sdr.open({
            ppm: 0,
            gain: null
        });
        await this.sdr.setSampleRate(2e6);
        await this.sdr.setCenterFrequency(434e6);
        await this.sdr.resetBuffer();

    }


    get_supported_params(): string[] {
        return ["gain", "bw", "sample_rate", "frequency"];
    }
    
    async set_frequency(freq: number): Promise<void>
    {
        await this.sdr.setCenterFrequency(freq);
    }

    async set_sample_rate(rate: number): Promise<void>
    {
        await this.sdr.setSampleRate(rate);
    }

    async set_gain(gain: number): Promise<void> {
        //this.sdr.setGain(gain);
    }
    async set_bw(freq: number): Promise<void> {
        //this.sdr.setGain(freq);
    }
    

    async set_param(name: string, value: SDRParamValue): Promise<void> {
        switch (name) {
            case "frequency":
                await this.set_frequency(value as number);
                break;
            case "sample_rate":
                await this.set_sample_rate(value as number);
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
    




    async disconnect(): Promise<void>
    {
        if (this.sdr) {
            await this.sdr.close();
            this.sdr = null;
        }
    }

    async start_rx(): Promise<void>
    {
        await this.sdr.resetBuffer();
    }

    stop_rx(): void
    {
        // stub 
    }

    async read(length: number = 16 * 16384): Promise<Uint8Array | null>
    {
        try
        {
            const result = await this.sdr.readSamples(length);
            return new Uint8Array(result);
        }
        catch (err)
        {
            console.error(err);
            return null;
        }
    }

    parse(raw: Uint8Array): IQSample[]
    {
        const iq: IQSample[] = [];
        for (let i = 0; i + 1 < raw.length; i += 2)
        {
            iq.push({
                i: int8val(raw[i] - 128),
                q: int8val(raw[i + 1] - 128)
            });
        }
        return iq;
    }


}
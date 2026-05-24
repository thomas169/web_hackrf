import { IQSample, SDRParamValue } from "../common/types.js";

export interface ISDRDevice
{
    connect(): Promise<void>;

    disconnect(): Promise<void>;

    start_rx(): Promise<void>;

    read(length?: number): Promise<Uint8Array | null>;

    stop_rx(): void;

    parse(raw: Uint8Array): IQSample[];

    set_param(name: string, value: SDRParamValue): Promise<void>
    get_supported_params(): string[];

}
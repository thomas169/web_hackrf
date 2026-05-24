// src/common/types.ts

export type Int8 = number & { readonly __brand: "int8" };

export interface IQSample {
    i: Int8;
    q: Int8;
}

export function int8(n: number): Int8 {
    if (!Number.isInteger(n) || n < -128 || n > 127)
        throw new RangeError(`${n} is not int8`);
    return (n as Int8);
}

export type SDRParamValue = number | boolean;

// ── Types ────────────────────────────────────────────────────
export type Uint32  = number & { readonly __brand: "uint32"  };
export type Uint16  = number & { readonly __brand: "uint16"  };
export type Int8Val = number & { readonly __brand: "int8"    };
export type Uint8Val = number & { __uint8__: void };



export function uint8val(n: number): Uint8Val
{
    if (!Number.isInteger(n) || n < 0 || n > 255)
        throw new RangeError(`${n} is not a valid uint8`);

    return (n & 0xFF) as Uint8Val;
}

export function uint32(n: number): Uint32 {
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFF_FFFF)
        throw new RangeError(`${n} is not a valid uint32`);
    return (n >>> 0) as Uint32;
}

export function uint16(n: number): Uint16 {
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFF)
        throw new RangeError(`${n} is not a valid uint16`);
    return (n & 0xFFFF) as Uint16;
}

export function int8val(n: number): Int8Val {
    if (!Number.isInteger(n) || n < -128 || n > 127)
        throw new RangeError(`${n} is not a valid int8`);
    return (n << 24 >> 24) as Int8Val;
}


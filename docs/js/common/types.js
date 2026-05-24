// src/common/types.ts
export function int8(n) {
    if (!Number.isInteger(n) || n < -128 || n > 127)
        throw new RangeError(`${n} is not int8`);
    return n;
}
export function uint8val(n) {
    if (!Number.isInteger(n) || n < 0 || n > 255)
        throw new RangeError(`${n} is not a valid uint8`);
    return (n & 0xFF);
}
export function uint32(n) {
    if (!Number.isInteger(n) || n < 0 || n > 4294967295)
        throw new RangeError(`${n} is not a valid uint32`);
    return (n >>> 0);
}
export function uint16(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFF)
        throw new RangeError(`${n} is not a valid uint16`);
    return (n & 0xFFFF);
}
export function int8val(n) {
    if (!Number.isInteger(n) || n < -128 || n > 127)
        throw new RangeError(`${n} is not a valid int8`);
    return (n << 24 >> 24);
}

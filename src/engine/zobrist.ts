// Deterministic 64-bit Zobrist keys, stored as pairs of 32-bit halves.
// JS bitwise ops are 32-bit, so keeping lo/hi apart is both fast and exact.

function xorshift128(seed: number) {
  let x = seed >>> 0 || 0x9e3779b9, y = 0x243f6a88, z = 0xb7e15162, w = 0x6a09e667;
  return (): number => {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w;
  };
}

const rnd = xorshift128(0x5eed1234);
// Warm up the generator.
for (let i = 0; i < 64; i++) rnd();

// [piece 16][square 128]
export const PIECE_KEY_LO = new Uint32Array(16 * 128);
export const PIECE_KEY_HI = new Uint32Array(16 * 128);
export const CASTLE_KEY_LO = new Uint32Array(16);
export const CASTLE_KEY_HI = new Uint32Array(16);
export const EP_KEY_LO = new Uint32Array(8);
export const EP_KEY_HI = new Uint32Array(8);
export let SIDE_KEY_LO = 0;
export let SIDE_KEY_HI = 0;

for (let i = 0; i < 16 * 128; i++) { PIECE_KEY_LO[i] = rnd(); PIECE_KEY_HI[i] = rnd(); }
for (let i = 0; i < 16; i++) { CASTLE_KEY_LO[i] = rnd(); CASTLE_KEY_HI[i] = rnd(); }
for (let i = 0; i < 8; i++) { EP_KEY_LO[i] = rnd(); EP_KEY_HI[i] = rnd(); }
SIDE_KEY_LO = rnd();
SIDE_KEY_HI = rnd();

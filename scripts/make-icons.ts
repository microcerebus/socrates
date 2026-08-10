/**
 * Generates the extension icons: a ladder, which is the whole product in one mark.
 *
 * Run with `pnpm icons` (Node's built-in TypeScript stripping - no build step).
 * The PNGs are committed, so this only needs re-running if the mark changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT_DIR = resolve(import.meta.dirname, '../public/icons');
const SIZES = [16, 32, 48, 128];

const INK: [number, number, number] = [0x4f, 0x5d, 0x95];
const PAPER: [number, number, number] = [0xfb, 0xfa, 0xf8];

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.22;

  const set = (x: number, y: number, colour: [number, number, number]): void => {
    const index = (y * size + x) * 4;
    pixels[index] = colour[0];
    pixels[index + 1] = colour[1];
    pixels[index + 2] = colour[2];
    pixels[index + 3] = 255;
  };

  const insideRounded = (x: number, y: number): boolean => {
    const nx = Math.min(x, size - 1 - x);
    const ny = Math.min(y, size - 1 - y);
    if (nx >= radius || ny >= radius) return true;
    const dx = radius - nx;
    const dy = radius - ny;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (insideRounded(x, y)) set(x, y, INK);
    }
  }

  // Two rails and four rungs, in paper on ink.
  const bar = Math.max(1, Math.round(size * 0.09));
  const rungBar = Math.max(1, Math.round(size * 0.055));
  const railInset = Math.round(size * 0.26);
  const top = Math.round(size * 0.16);
  const bottom = size - top;

  const fillRect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x += 1) set(x, y, PAPER);
    }
  };

  fillRect(railInset, top, railInset + bar, bottom);
  fillRect(size - railInset - bar, top, size - railInset, bottom);

  const rungs = size <= 16 ? 3 : 4;
  const span = bottom - top - rungBar;
  for (let i = 0; i < rungs; i += 1) {
    const y = Math.round(top + rungBar + (i * (span - 2 * rungBar)) / (rungs - 1));
    fillRect(railInset, y, size - railInset, y + rungBar);
  }

  return pixels;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(size, draw(size)));
  process.stdout.write(`wrote ${file}\n`);
}

// Hand-drawn SVG piece set ("Ply"). Each piece lives in a 45x45 viewBox.
// White pieces: warm ivory fill with a dark outline. Black pieces: graphite fill
// with pale detail lines so features stay legible on dark squares.
import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, pieceColor, pieceType } from '../engine/types';

const W_FILL = '#f5f0e6', W_LINE = '#2c2a28';
const B_FILL = '#2f2e33', B_LINE = '#141317', B_DETAIL = '#9a98a4';

function base(color: number, w1: number, w2: number, y: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const x1 = 22.5 - w1 / 2, x2 = 22.5 + w1 / 2, x3 = 22.5 - w2 / 2, x4 = 22.5 + w2 / 2;
  return `<path d="M${x1},${y} L${x2},${y} L${x4},${y + 2.6} L${x4},${y + 4.4} L${x3},${y + 4.4} L${x3},${y + 2.6} Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>`;
}

function pawn(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  return `
    ${base(color, 19, 23, 34.5)}
    <path d="M14.5,34.5 C14.5,30 17,27.5 19.5,26.2 C18,25 17.2,23.2 17.2,21.3 C17.2,18.6 18.9,16.5 21,15.7 C19.6,14.8 18.9,13.4 18.9,11.9 C18.9,9.6 20.5,8 22.5,8 C24.5,8 26.1,9.6 26.1,11.9 C26.1,13.4 25.4,14.8 24,15.7 C26.1,16.5 27.8,18.6 27.8,21.3 C27.8,23.2 27,25 25.5,26.2 C28,27.5 30.5,30 30.5,34.5 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function rook(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const detail = color === WHITE ? W_LINE : B_DETAIL;
  return `
    ${base(color, 21, 25, 34.5)}
    <path d="M13.5,34.5 L31.5,34.5 L29.8,30.5 L15.2,30.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M15.8,30.5 L29.2,30.5 L28.3,17.5 L16.7,17.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M14.5,17.5 L30.5,17.5 L30.5,9.5 L26.8,9.5 L26.8,12.5 L24.3,12.5 L24.3,9.5 L20.7,9.5 L20.7,12.5 L18.2,12.5 L18.2,9.5 L14.5,9.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M17.3,20.5 L27.7,20.5 M16.9,27.5 L28.1,27.5" stroke="${detail}" stroke-width="1" fill="none" opacity="0.85"/>`;
}

function knight(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const detail = color === WHITE ? W_LINE : B_DETAIL;
  return `
    ${base(color, 22, 26, 34.5)}
    <path d="M12.5,34.5 C12.5,30.5 13.2,27.5 15.5,24.5 C13.5,24.8 11.8,23.5 11.3,22 C10.8,20.5 11.8,19.5 13,17.8 C15,15 17.5,13.2 20.2,12.2 L19.8,8.2 C21.3,9.2 22.8,10.6 23.6,11.8 C25,11.6 26.3,11.9 27.5,12.6 L29.6,8.5 C30.6,10.6 31.1,12.9 31.1,15.1 C34.4,18.3 35.3,23.5 33.6,34.5 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M15.4,24.4 C16.5,23.9 17.2,23.2 17.6,22.1 C18.1,20.8 17.2,19.9 16.1,20.3 C15.1,20.7 14.9,21.9 15.4,22.5" fill="none" stroke="${detail}" stroke-width="1.1" stroke-linecap="round"/>
    <circle cx="26.1" cy="16.3" r="1.25" fill="${detail}"/>
    <path d="M13.4,21.3 C13.9,20.7 14.4,20.5 14.9,20.6" fill="none" stroke="${detail}" stroke-width="1" stroke-linecap="round"/>
    <path d="M30.4,16.5 C32.5,20 33,25 32.1,31" fill="none" stroke="${detail}" stroke-width="0.9" stroke-linecap="round" opacity="0.6"/>`;
}

function bishop(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const detail = color === WHITE ? W_LINE : B_DETAIL;
  return `
    ${base(color, 20, 24, 34.5)}
    <path d="M16.5,34.5 L28.5,34.5 L28.5,31.5 L16.5,31.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M22.5,10.8 C18,13.2 15,18.3 15,23.5 C15,27.2 17.2,30.2 19.5,31.5 L25.5,31.5 C27.8,30.2 30,27.2 30,23.5 C30,18.3 27,13.2 22.5,10.8 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="22.5" cy="8.4" r="2.4" fill="${fill}" stroke="${line}" stroke-width="1.4"/>
    <path d="M22.5,16.5 L25.2,23.6" stroke="${detail}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M17.6,27.4 L27.4,27.4" stroke="${detail}" stroke-width="1" opacity="0.85"/>`;
}

function queen(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const detail = color === WHITE ? W_LINE : B_DETAIL;
  return `
    ${base(color, 22, 26, 34.5)}
    <path d="M13.2,34.5 C13.2,32 13.8,30.8 14.6,29.8 L30.4,29.8 C31.2,30.8 31.8,32 31.8,34.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M9.8,15.5 L14.6,29.8 L30.4,29.8 L35.2,15.5 L29.4,25.2 L28.6,11.8 L24.9,24.6 L22.5,10 L20.1,24.6 L16.4,11.8 L15.6,25.2 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="9.3" cy="13.6" r="1.9" fill="${fill}" stroke="${line}" stroke-width="1.3"/>
    <circle cx="16" cy="9.8" r="1.9" fill="${fill}" stroke="${line}" stroke-width="1.3"/>
    <circle cx="22.5" cy="7.8" r="1.9" fill="${fill}" stroke="${line}" stroke-width="1.3"/>
    <circle cx="29" cy="9.8" r="1.9" fill="${fill}" stroke="${line}" stroke-width="1.3"/>
    <circle cx="35.7" cy="13.6" r="1.9" fill="${fill}" stroke="${line}" stroke-width="1.3"/>
    <path d="M14.9,27.2 C19,26 26,26 30.1,27.2" fill="none" stroke="${detail}" stroke-width="1" opacity="0.85"/>`;
}

function king(color: number): string {
  const fill = color === WHITE ? W_FILL : B_FILL;
  const line = color === WHITE ? W_LINE : B_LINE;
  const detail = color === WHITE ? W_LINE : B_DETAIL;
  return `
    ${base(color, 22, 26, 34.5)}
    <path d="M13.5,34.5 C13.5,32 14,30.6 14.8,29.5 L30.2,29.5 C31,30.6 31.5,32 31.5,34.5 Z" fill="${fill}" stroke="${line}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M22.5,5.2 L22.5,12.4 M19.4,8.4 L25.6,8.4" stroke="${line}" stroke-width="2.3" stroke-linecap="round"/>
    <path d="M22.5,16.6 C23.6,13 27.9,11.2 31.2,13.3 C34.3,15.3 34.6,19.8 32.1,23.1 C30.9,24.7 30.2,27 30.2,29.5 L14.8,29.5 C14.8,27 14.1,24.7 12.9,23.1 C10.4,19.8 10.7,15.3 13.8,13.3 C17.1,11.2 21.4,13 22.5,16.6 Z"
      fill="${fill}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M22.5,16.6 L22.5,27.5" stroke="${detail}" stroke-width="1.1" opacity="0.85"/>
    <path d="M15.6,27.3 C19,26.2 26,26.2 29.4,27.3" fill="none" stroke="${detail}" stroke-width="1" opacity="0.85"/>`;
}

const cache = new Map<number, string>();

export function pieceSvg(piece: number): string {
  const hit = cache.get(piece);
  if (hit) return hit;
  const color = pieceColor(piece);
  const type = pieceType(piece);
  let body = '';
  switch (type) {
    case PAWN: body = pawn(color); break;
    case KNIGHT: body = knight(color); break;
    case BISHOP: body = bishop(color); break;
    case ROOK: body = rook(color); break;
    case QUEEN: body = queen(color); break;
    case KING: body = king(color); break;
  }
  const svg = `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g class="piece-shadow">${body}</g></svg>`;
  cache.set(piece, svg);
  return svg;
}

import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** Curated sticker colours (highlight, base, edge) that sit with the SLOPMUX palette. */
const STICKERS = [
  ['#d3e39a', '#b9cf7a', '#93a85a'], // lime
  ['#e8cc7a', '#d6b65a', '#a88b3a'], // mustard
  ['#aecdc5', '#8fb3aa', '#6a8e85'], // teal grey
  ['#aebbda', '#8e9fc4', '#6a7ba2'], // slate blue
  ['#e6b39a', '#d49a7e', '#a8735a'], // clay
  ['#c3a6c2', '#a98aa8', '#836581'], // plum
  ['#aabd86', '#8fa36b', '#6b7d4d'], // moss
  ['#e8d7b1', '#d8c49a', '#ae9a70'], // sand
] as const;

/** A stable sticker for a group name, so the same group always gets the same colour. */
export const groupSticker = (name: string): { hi: string; base: string; lo: string } => {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const [hi, base, lo] = STICKERS[hash % STICKERS.length] ?? STICKERS[0];
  return { hi, base, lo };
};

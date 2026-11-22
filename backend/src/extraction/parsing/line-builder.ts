import type { Line, Word } from '../types.js';

/** Groups words into lines: words whose vertical centres are close belong to the same row. */
export function buildLines(words: Word[], page: number): Line[] {
  if (!words.length) return [];
  const heights = words.map((w) => w.height).sort((a, b) => a - b);
  const tolerance = Math.max(3, heights[Math.floor(heights.length / 2)] * 0.5);

  const sorted = [...words].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  const groups: Word[][] = [];
  let current: Word[] = [];
  let currentCenter = 0;

  for (const word of sorted) {
    const center = word.y + word.height / 2;
    if (current.length && Math.abs(center - currentCenter) > tolerance) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    currentCenter = current.reduce((sum, w) => sum + w.y + w.height / 2, 0) / current.length;
  }
  if (current.length) groups.push(current);

  return groups.map((group) => {
    const lineWords = group.sort((a, b) => a.x - b.x);
    return {
      page,
      y: Math.min(...lineWords.map((w) => w.y)),
      words: lineWords,
      text: lineWords.map((w) => w.text).join(' '),
    };
  });
}

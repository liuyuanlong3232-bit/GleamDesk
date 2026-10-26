/** Move only during pointer input. Offset centers from their stable layout positions. */
export function dockMagnification(centers: number[], pointerX: number | null) {
  const scales = centers.map(center => pointerX === null ? 1 : 1 + 0.4 * (1 + Math.cos(Math.min(1, Math.abs(center - pointerX) / 164) * Math.PI)) / 2);
  const extras = scales.map(scale => 64 * (scale - 1));
  const total = extras.reduce((sum, extra) => sum + extra, 0);
  let previous = 0;
  return scales.map((scale, index) => {
    const shift = previous + extras[index] / 2 - total / 2;
    previous += extras[index];
    return { scale, shift, lift: (scale - 1) * 28 };
  });
}
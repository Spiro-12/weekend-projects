// Grid montage of images with captions (sharp only). Used for thumbnail checks and the spike contact sheet.
// Usage: tsx scripts/assets/montage.ts out.png cellWidth cols img1 [img2 ...]
import sharp from 'sharp';
import { basename } from 'node:path';

export async function montage(out: string, files: string[], cell = 320, cols = 4, labels?: string[], cellH = cell): Promise<void> {
  const rows = Math.ceil(files.length / cols);
  const capH = 22;
  const tiles = await Promise.all(
    files.map(async (f, i) => {
      const img = await sharp(f).resize(cell, cellH, { fit: 'contain', background: '#202226' }).png().toBuffer();
      const label = (labels?.[i] ?? basename(f)).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const cap = Buffer.from(
        `<svg width="${cell}" height="${capH}"><rect width="100%" height="100%" fill="#111"/>` +
          `<text x="6" y="15" font-family="Helvetica" font-size="13" fill="#ddd">${label}</text></svg>`,
      );
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * (cellH + capH);
      return [
        { input: img, left: x, top: y },
        { input: cap, left: x, top: y + cellH },
      ];
    }),
  );
  await sharp({ create: { width: cols * cell, height: rows * (cellH + capH), channels: 3, background: '#000' } })
    .composite(tiles.flat())
    .png()
    .toFile(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, cell, cols, ...files] = process.argv.slice(2);
  await montage(out, files, Number(cell), Number(cols));
  console.log('wrote', out);
}

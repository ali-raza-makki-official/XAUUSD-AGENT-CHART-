// Generates build/icon.png (512) and build/icon.ico (16..256) from design/logo.svg.
// Run: npm run icons -w @aurum/desktop   (generated files are committed; sharp/png-to-ico are devDependencies only)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, '../../../design/logo.svg'));
const out = join(here, '../build');
mkdirSync(out, { recursive: true });

const render = (size) => sharp(svg, { density: Math.max(72, size * 2) }).resize(size, size).png().toBuffer();

writeFileSync(join(out, 'icon.png'), await render(512));
const sizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(join(out, 'icon.ico'), await pngToIco(await Promise.all(sizes.map(render))));
console.log('wrote build/icon.png and build/icon.ico', sizes.join(','));

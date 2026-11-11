import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "packages/desktop/assets/advanced");
const app = path.join(root, "packages/app/assets/images/advanced");
const web = path.join(root, "packages/app/public/advanced");
for (const directory of [desktop, app, web]) await mkdir(directory, { recursive: true });
const master = await readFile(path.join(desktop, "icon.svg"), "utf8");
const foreground = master.replace(/\s*<rect id="tile"[^>]*\/>/, "");

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
}

await png(master, 512, path.join(desktop, "icon.png"));
await png(master, 1024, path.join(app, "icon.png"));
await png(master, 1024, path.join(app, "splash-icon.png"));
await png(foreground, 1024, path.join(app, "android-icon-foreground.png"));
await png(foreground, 96, path.join(app, "notification-icon.png"));
await png(master, 48, path.join(app, "favicon.png"));

const statusMarks = {
  "": "",
  "-running":
    '<circle cx="424" cy="424" r="74" fill="#16A34A" stroke="#FFFFFF" stroke-width="18"/>',
  "-attention":
    '<circle cx="424" cy="424" r="74" fill="#FACC15" stroke="#FFFFFF" stroke-width="18"/><path d="M424 384V428" stroke="#422006" stroke-width="18" stroke-linecap="round"/><circle cx="424" cy="458" r="10" fill="#422006"/>',
};
for (const theme of ["dark", "light"]) {
  for (const [status, mark] of Object.entries(statusMarks)) {
    const svg = master.replace("</svg>", `${mark}</svg>`);
    const basename = `favicon-${theme}${status}`;
    await writeFile(path.join(app, `${basename}.svg`), svg);
    await png(svg, 48, path.join(app, `${basename}.png`));
  }
}
for (const [name, size] of [
  ["pwa-icon-192.png", 192],
  ["pwa-icon-512.png", 512],
  ["apple-touch-icon.png", 180],
  ["favicon.png", 48],
]) {
  await png(master, size, path.join(web, name));
}

// Modern Windows ICO entries embed PNG bytes. Include small native sizes so
// taskbar, titlebar, Explorer and installer shortcuts share the same sharp mark.
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const images = [];
for (const size of sizes)
  images.push(await sharp(Buffer.from(master)).resize(size, size).png().toBuffer());
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(path.join(desktop, "icon.ico"), Buffer.concat([header, ...images]));
console.log(
  `Generated Paseo Advanced desktop/app/web icons and ${sizes.length} Windows ICO resolutions.`,
);

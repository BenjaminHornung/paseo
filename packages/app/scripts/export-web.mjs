import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const inlineOutput = args.find((arg) => arg.startsWith("--output-dir="));
const outputDir =
  outputIndex !== -1
    ? args[outputIndex + 1]
    : (inlineOutput?.slice("--output-dir=".length) ?? "dist");
if (!outputDir) throw new Error("--output-dir requires a directory");

const result = spawnSync(
  process.execPath,
  [require.resolve("expo/bin/cli"), "export", "--platform", "web", ...args],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.env.EXPO_PUBLIC_PASEO_DISTRIBUTION === "advanced") {
  const indexPath = path.resolve(projectRoot, outputDir, "index.html");
  let html = readFileSync(indexPath, "utf8");
  const replacements = [
    [
      'name="apple-mobile-web-app-title" content="Paseo"',
      'name="apple-mobile-web-app-title" content="Paseo Advanced"',
    ],
    ['rel="manifest" href="/manifest.json"', 'rel="manifest" href="/advanced/manifest.json"'],
    [
      'rel="apple-touch-icon" href="/apple-touch-icon.png"',
      'rel="apple-touch-icon" href="/advanced/apple-touch-icon.png"',
    ],
  ];
  for (const [original, replacement] of replacements) {
    if (html.split(original).length !== 2) {
      throw new Error(`Expected exactly one web template entry: ${original}`);
    }
    html = html.replace(original, replacement);
  }
  writeFileSync(indexPath, html);
}

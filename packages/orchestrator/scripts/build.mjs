import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkPackage = JSON.parse(await readFile(path.join(root, "../client/package.json"), "utf8"));
const result = await build({
  absWorkingDir: root,
  entryPoints: [
    "src/settings-rpc.ts",
    "src/cli.ts",
    "src/watch-lock.ts",
    "pi/extensions/orchestrator-tools.mjs",
    "pi/extensions/luna-provider-guard.mjs",
  ],
  outdir: "dist",
  outbase: ".",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  metafile: true,
  plugins: [
    {
      name: "preserve-watch-worker",
      setup(builder) {
        // The heartbeat worker must re-enter its own module, never the bundled CLI.
        builder.onResolve({ filter: /^\.\/watch-lock\.ts$/ }, () => ({
          path: "./watch-lock.js",
          external: true,
        }));
      },
    },
  ],
  banner: {
    js: 'import { createRequire as __advancedCreateRequire } from "node:module"; const require = __advancedCreateRequire(import.meta.url);',
  },
});
const inputs = Object.keys(result.metafile.inputs).sort();
const hash = createHash("sha256");
for (const input of inputs) {
  hash.update(input);
  hash.update(await readFile(path.resolve(root, input)));
}
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(
  path.join(root, "dist/package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
await writeFile(
  path.join(root, "dist/build-info.json"),
  JSON.stringify(
    {
      candidateRevision: "80c9ef3a278d8be4fea59ce9b79cc9ab37a71075df0ce60f59b9aad350da9390",
      compiledInputSha256: hash.digest("hex"),
      sdk: `${sdkPackage.name}@${sdkPackage.version}`,
      bundledWorkspaceSdk: inputs.some((input) => input.includes("../client/dist/")),
    },
    null,
    2,
  ),
);
if (!inputs.some((input) => input.includes("../client/dist/"))) {
  throw new Error("Controller must bundle the compiled fork SDK from this workspace");
}

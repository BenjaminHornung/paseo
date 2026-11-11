import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkPackage = JSON.parse(await readFile(path.join(root, "../client/package.json"), "utf8"));
// A directory plugin is compiled again by its installed daemon. Bundle its own
// dependencies now, while the workspace SDK is available; only public host
// modules remain external. Raw sources resolve against checkout node_modules
// during CI but fail after installation outside the checkout.
const pluginResults = [];
for (const target of ["client", "server"]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`paseo-plugin/index.${target}.${target === "client" ? "tsx" : "ts"}`],
    outfile: `dist/paseo-plugin/index.${target}.ts`,
    bundle: true,
    platform: target === "server" ? "node" : "neutral",
    mainFields: target === "client" ? ["module", "main"] : undefined,
    format: "esm",
    jsx: "automatic",
    target: target === "server" ? "node24" : "es2020",
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/*",
      "zod",
      "react",
      "react/*",
      "react-native",
      "@tanstack/react-query",
    ],
    metafile: true,
  });
  pluginResults.push(result);
}
const pluginInputs = [
  ...new Set(pluginResults.flatMap((result) => Object.keys(result.metafile.inputs))),
].sort();
if (!pluginInputs.some((input) => input.includes("../client/dist/"))) {
  throw new Error("Plugin must bundle the compiled fork SDK from this workspace");
}
const pluginHash = createHash("sha256");
for (const input of pluginInputs) {
  pluginHash.update(input);
  pluginHash.update(await readFile(path.resolve(root, input)));
}
await copyFile(
  path.join(root, "paseo-plugin/paseo-plugin.json"),
  path.join(root, "dist/paseo-plugin/paseo-plugin.json"),
);
const pluginFileSha256 = {};
for (const file of ["index.client.ts", "index.server.ts", "paseo-plugin.json"]) {
  pluginFileSha256[file] = createHash("sha256")
    .update(await readFile(path.join(root, "dist/paseo-plugin", file)))
    .digest("hex");
}
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
const compiledInputSha256 = hash.digest("hex");
const controllerFileSha256 = {};
for (const output of Object.keys(result.metafile.outputs).sort()) {
  const file = path.resolve(root, output);
  const relative = path.relative(path.join(root, "dist"), file).replaceAll("\\", "/");
  controllerFileSha256[relative] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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
      sourceCommit: process.env.GITHUB_SHA ?? null,
      sourceRepository: process.env.GITHUB_REPOSITORY ?? null,
      compiledInputSha256,
      controllerFileSha256,
      // Intake confirmation adds a controller RPC. A plugin-only repair must
      // never advertise compatibility with a controller lacking that operation.
      pluginCompatibleControllerInputSha256: [compiledInputSha256],
      controllerRepair: {
        compatibleBaseInputSha256: [
          "176685ed8dce0112d082940dc24dcf839ab0ab190d34134a1673cdba8d8fbd7b",
          "f144eecf2e112f76c1a7af4f6ff4a965ae211b3f58f1a4f59f8b35c36641f9ec",
          "95f0b1c7089000a5de10d96fc260b3b25892e3e160f7b5c077aabc6615c216fa",
        ],
        minimumNodeMajor: 24,
        scope: [
          "dist/",
          "paseo-plugin/index.client.ts",
          "paseo-plugin/index.server.ts",
          "paseo-plugin/paseo-plugin.json",
        ],
        includesUserState: false,
        daemonRestartRequired: false,
      },
      pluginPreparationConnection: { requiresPasswordlessLoopback: true, credentialLookup: false },
      pluginClientCompatibility: {
        requiredUiExports: ["ActiveSubagents"],
        delivery: "matching-full-advanced-package",
        standaloneRepairSupported: false,
      },
      pluginCompiledInputSha256: pluginHash.digest("hex"),
      pluginFileSha256,
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

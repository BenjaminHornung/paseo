const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const upstream = yaml.load(fs.readFileSync(path.join(__dirname, "electron-builder.yml"), "utf8"));
const sourcePackage = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const upstreamVersion = sourcePackage.version;
if (typeof upstreamVersion !== "string" || !upstreamVersion.startsWith("0.")) {
  throw new Error("Review the Advanced version mapping when upstream changes its major version.");
}
const advancedVersion = `1.${upstreamVersion.slice(2)}`;

// Builder's `extends` concatenates arrays. Replace protocols and the Windows CLI
// explicitly so installing Advanced cannot claim upstream's handler or command.
module.exports = {
  ...upstream,
  extends: null,
  appId: "sh.paseo.advanced",
  productName: "Paseo Advanced",
  executableName: "PaseoAdvanced",
  extraResources: [
    ...upstream.extraResources,
    { from: "../orchestrator/dist", to: "orchestrator/dist", filter: ["!paseo-plugin/**"] },
    {
      from: "../orchestrator/config",
      to: "orchestrator/config",
      filter: ["controller.local.example.json"],
    },
    { from: "../orchestrator/scripts", to: "orchestrator/scripts", filter: ["!build.mjs"] },
    { from: "../orchestrator/pi", to: "orchestrator/pi", filter: ["paseo-advanced-pi.cmd"] },
    {
      from: "../orchestrator/dist/paseo-plugin",
      to: "orchestrator/paseo-plugin",
    },
  ],
  protocols: [{ name: "Paseo Advanced agent link", schemes: ["paseo-advanced"] }],
  extraMetadata: {
    name: "paseo-advanced",
    productName: "Paseo Advanced",
    version: advancedVersion,
    paseoUpstreamVersion: upstreamVersion,
  },
  publish: { provider: "github", owner: "BenjaminHornung", repo: "paseo" },
  win: {
    ...upstream.win,
    icon: "assets/advanced/icon.ico",
    artifactName: "Paseo-Advanced-${version}-${arch}.${ext}",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "zip", arch: ["x64"] },
    ],
    extraResources: [
      { from: "bin/paseo-advanced.cmd", to: "bin/paseo-advanced.cmd" },
      { from: "assets/advanced/icon.ico", to: "icon.ico" },
      { from: "assets/advanced/icon.png", to: "icon.png" },
    ],
  },
  nsis: {
    ...upstream.nsis,
    shortcutName: "Paseo Advanced",
    uninstallDisplayName: "Paseo Advanced",
  },
};

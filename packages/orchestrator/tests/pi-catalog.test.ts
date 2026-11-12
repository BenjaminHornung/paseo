import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Discovery has no worker monitor. It must read metadata without forwarding a model prompt.
test(
  "the unbound Pi launcher serves catalog RPCs and rejects prompts before forwarding",
  {
    skip: process.platform !== "win32",
  },
  (context) => {
    const state = path.join(process.cwd(), "state");
    mkdirSync(state, { recursive: true });
    const root = mkdtempSync(path.join(state, "pi-catalog-"));
    context.after(() => {
      assert.equal(path.dirname(root), state);
      rmSync(root, { recursive: true, force: true });
    });
    const extensionDirectory = path.join(root, "dist/pi/extensions");
    mkdirSync(extensionDirectory, { recursive: true });
    writeFileSync(
      path.join(extensionDirectory, "luna-provider-guard.js"),
      "export default function () {}\n",
    );
    const cli = path.join(root, "cli.js"),
      received = path.join(root, "received.jsonl");
    const argumentsFile = path.join(root, "launch.json");
    writeFileSync(
      cli,
      `import fs from "node:fs"; import readline from "node:readline";
fs.writeFileSync(process.env.CATALOG_TEST_ARGUMENTS,JSON.stringify({args:process.argv.slice(2),profile:process.env.PI_CODING_AGENT_DIR}));
readline.createInterface({input:process.stdin}).on("line",line=>{
  const request=JSON.parse(line);fs.appendFileSync(process.env.CATALOG_TEST_RECEIVED,JSON.stringify(request.type)+"\\n");
  process.stdout.write(JSON.stringify({type:"response",id:request.id,command:request.type,success:true,
    data:request.type==="get_available_models"?{models:[]}:{model:{id:"offline",provider:"fixture"}}})+"\\n");
});\n`,
    );
    const launcher = path.join(root, "pi.cmd");
    writeFileSync(launcher, `"${process.execPath}" "${cli}" --skill "%~dp0profile\\skills" %*\r\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PASEO_ORCHESTRATOR_ROOT: root,
      PASEO_ORCHESTRATOR_DATA_ROOT: root,
      PASEO_ORCHESTRATOR_PI_BASE_LAUNCHER: launcher,
      CATALOG_TEST_RECEIVED: received,
      CATALOG_TEST_ARGUMENTS: argumentsFile,
    };
    delete env.PASEO_ORCHESTRATOR_PROCESS_MONITOR;
    delete env.PASEO_ORCHESTRATOR_BUDGET_FILE;
    delete env.PASEO_ORCHESTRATOR_LUNA_GUARD;
    const requests = [
      { id: "models", type: "get_available_models" },
      { id: "state", type: "get_state" },
      { id: "prompt", type: "prompt", message: "must never reach the model runtime" },
    ];
    const run = spawnSync(
      process.execPath,
      [path.resolve("scripts/pi-supervisor.mjs"), "--mode", "rpc"],
      {
        cwd: process.cwd(),
        env,
        input: requests.map((value) => JSON.stringify(value)).join("\n") + "\n",
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const launch = JSON.parse(readFileSync(argumentsFile, "utf8"));
    assert.equal(
      launch.args.includes("--skill"),
      false,
      "legacy profile skills must not override the owned profile",
    );
    assert.equal(launch.profile, path.join(root, "state/pi-profile"));
    assert.deepEqual(
      readFileSync(received, "utf8")
        .trim()
        .split("\n")
        .map((value) => JSON.parse(value)),
      ["get_available_models", "get_state"],
    );
    const replies = run.stdout
      .trim()
      .split("\n")
      .map((value) => JSON.parse(value));
    assert.equal(replies.find((value) => value.id === "models")?.success, true);
    assert.equal(replies.find((value) => value.id === "state")?.success, true);
    assert.deepEqual(
      replies.find((value) => value.id === "prompt"),
      {
        type: "response",
        id: "prompt",
        command: "prompt",
        success: false,
        error: "PI_CATALOG_ONLY_NO_PROMPTS",
      },
    );
  },
);

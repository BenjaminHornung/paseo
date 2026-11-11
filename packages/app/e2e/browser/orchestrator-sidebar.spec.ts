import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { seedWorkspace } from "../support/helpers/seed-client";
import { seedParentWithSubagent } from "../support/helpers/subagents";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

test.use({ channel: "chrome", video: "off" });

// Consequential regression: a reconstructed sidebar must use the shipped client and
// retain its real Details/confirmation entry point, rather than displaying old data
// or losing the only supported confirmation control. All RPC answers below are
// explicitly synthetic, private UI data; no controller task or model is invoked.
test("shipped orchestrator sidebar keeps native children and confirmation accessible", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  expect(process.env.E2E_FORK_PASEO_HOME_FROM).toBeUndefined();
  const workspace = await seedWorkspace({ repoPrefix: "advanced-sidebar-ui-" });
  const client = await connectDaemonClient<
    Pick<
      DaemonClient,
      "connect" | "close" | "patchDaemonConfig" | "installDirectoryPlugin" | "invokePluginRpc"
    >
  >({ clientIdPrefix: "advanced-sidebar-ui" });
  const pair = await seedParentWithSubagent(workspace, {
    parentTitle: "Synthetic Advanced sidebar preview",
    childTitle:
      "Synthetic active child with a deliberately long descriptive name for ellipsis and tooltip",
  });
  const directory = await mkdtemp(path.join(tmpdir(), "advanced-sidebar-plugin-"));
  const bundle = path.resolve("../orchestrator/dist/paseo-plugin");
  const manifest = JSON.parse(await readFile(path.join(bundle, "paseo-plugin.json"), "utf8"));
  const config = JSON.parse(
    await readFile("../orchestrator/config/controller.local.example.json", "utf8"),
  );
  config.apiEnabled = false;
  config.decisions = { ...config.decisions, enabled: false };
  config.budgets = { decisions: 0, implementation: 0, "premium-api": 0, emergency: 0 };
  await mkdir(path.join(directory, "private-data"));
  await copyFile(path.join(bundle, "index.client.ts"), path.join(directory, "index.client.ts"));
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  let config = ${JSON.stringify(config)};
  const id = "a".repeat(64);
  let source = "decisions", approved = false;
  const handle = (name, callback) => server.handle(defineRpc({name, input:z.any(), output:z.any()}), callback);
  const settings = () => ({revision:"synthetic-ui",config,controllerRoot:${JSON.stringify(directory)},credentials:{normal:{present:false,source:"missing",revision:"none"},decisions:{present:false,source:"missing",revision:"none"}},usage:{cycle:"synthetic",committedMicroUsd:0,unknownCalls:0,calls:0},circuits:[],dispatchPaused:true,activeAttempts:0});
  handle("orchestrator.status", () => ({at:Date.now(),automation:"off",mainAgentId:${JSON.stringify(pair.parent.id)},runner:"stopped",dispatchPaused:true,tasks:[]}));
  handle("orchestrator.decisions-history", (input) => {
    if(source === "error") throw Error("SYNTHETIC_UI_ERROR");
    return {mainAgentId:${JSON.stringify(pair.parent.id)},items:[{id,kind:"intake",at:Date.now(),source,reason:"SYNTHETIC_UI_FIXTURE"}],...(input.assessmentId ? {detail:{id,input:"Synthetic public UI request; no pilot authorization.",result:JSON.stringify({intent:"new-task",needImplementation:true}),response:source === "decisions" ? JSON.stringify({answers:[]}) : null,diagnostics:null,request:null,source,reason:"SYNTHETIC_UI_FIXTURE",callState:"SETTLED",reservedMicroUsd:0,chargedMicroUsd:0,inputHash:"b".repeat(64),approval:{messageId:"synthetic-ui-only"},provenance:"synthetic-ui-fixture"}} : {})};
  });
  handle("orchestrator.approve-intake", () => {approved=true;return {approved:true,assessmentId:id};});
  handle("orchestrator.settings.get", settings);
  handle("orchestrator.settings.save", (input) => {config=input.config;return settings();});
  handle("e2e.preview", (input) => {if(input.source)source=input.source;return {source,approved,config};});
  return () => {};
}
`,
  );
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, pair.parent.id));
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("Orchestrator-Status / Auto-Routing");
    await commands
      .getByRole("button", { name: "Orchestrator-Status / Auto-Routing", exact: true })
      .click();
    await expect(page.getByText("Keine aktiven Subagents.", { exact: true })).toBeVisible();
    await expect(page.getByText("Decision-Ergebnis", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.getByText("Decision-Details", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Modellbewertung bestätigen…", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Ja, genau diese Intake-Bewertung bestätigen",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("sidebar-details.png") });
    // Leave the actual confirmation unsubmitted: the UI fixture is no human receipt.
    await page.keyboard.press("Escape");
    for (const [source, label] of [
      ["fallback", "Lokaler Controller-Fallback"],
      ["pending", "Decision ausstehend."],
      ["error", "Decision konnte nicht geladen werden."],
      ["decisions", "Decision-Ergebnis"],
    ]) {
      await client.invokePluginRpc(manifest.id, "e2e.preview", { source });
      await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 15_000 });
    }
    await workspace.client.sendAgentMessage(pair.child.id, "Synthetic ten-second UI stream only.");
    const child = page.getByRole("button", { name: pair.child.title, exact: true });
    await expect(child).toBeVisible();
    const measurements: { requested: number; actual: number; colorScheme: string }[] = [];
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [280, 400]) {
        const handle = page.getByTestId("workspace-explorer-sidebar-resize-handle");
        const box = await handle.boundingBox();
        if (!box) throw Error("Missing actual explorer resize handle");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(1440 - width, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        const resized = await handle.boundingBox();
        if (!resized) throw Error("Missing resized explorer handle");
        const actual = 1440 - resized.x - resized.width / 2;
        expect(Math.abs(actual - width)).toBeLessThan(8);
        measurements.push({ requested: width, actual, colorScheme });
        await page.mouse.move(50, 50);
        await child.blur();
        await page.screenshot({ path: info.outputPath(`sidebar-${width}-${colorScheme}.png`) });
      }
    }
    await child.click();
    await expect(
      page.getByTestId(`workspace-tab-agent_${pair.child.id}`).filter({ visible: true }).first(),
    ).toBeVisible();
    await writeFile(info.outputPath("panel-widths.json"), JSON.stringify(measurements, null, 2));
    const settingsCommands = await openCommandCenter(page);
    await settingsCommands.getByTestId("command-center-input").fill("Orchestrator-Einstellungen");
    await settingsCommands
      .getByRole("button", { name: "Orchestrator-Einstellungen", exact: true })
      .click();
    await page.getByRole("button", { name: /^Rolle oder Arbeitsart:/ }).click();
    await page.getByText("UI-Implementierung", { exact: true }).last().click();
    await page.getByRole("button", { name: /^Route hinzufügen:/ }).click();
    await page.getByRole("menuitem").nth(1).click();
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect
      .poll(async () => {
        const result = (await client.invokePluginRpc(manifest.id, "e2e.preview", {})) as {
          config: { roleRoutes?: { ui?: string[] } };
        };
        return result.config.roleRoutes?.ui;
      })
      .toEqual([config.routes[0].id]);
    await page.getByRole("button", { name: "Neu laden", exact: true }).click();
    await expect(page.getByText("Eigene UI-Reihenfolge", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("ui-routing-saved.png") });
  } finally {
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

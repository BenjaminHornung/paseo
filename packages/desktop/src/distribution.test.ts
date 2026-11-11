import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  configureDesktopDistributionEnvironment,
  normalizeDesktopAgentLink,
  resolveDesktopDistribution,
} from "./distribution";

describe("side-by-side desktop distribution", () => {
  it("packages the Advanced window and installer with the Advanced icons", () => {
    const config = createRequire(import.meta.url)("../electron-builder.advanced.cjs");
    expect(config.productName).toBe("Paseo Advanced");
    expect(config.win.icon).toBe("assets/advanced/icon.ico");
    expect(config.win.extraResources).toEqual(
      expect.arrayContaining([
        { from: "assets/advanced/icon.ico", to: "icon.ico" },
        { from: "assets/advanced/icon.png", to: "icon.png" },
      ]),
    );
  });

  it("isolates the Advanced daemon and CLI while leaving upstream defaults alone", () => {
    const env: NodeJS.ProcessEnv = {};
    const executablePath = path.join("install", "PaseoAdvanced.exe");
    configureDesktopDistributionEnvironment({ executablePath, env, userHome: "user-home" });
    expect(env).toEqual({
      PASEO_HOME: path.join("user-home", ".paseo-advanced"),
      PORT: "6777",
      PASEO_DESKTOP_EXECUTABLE: executablePath,
    });

    const upstreamEnv: NodeJS.ProcessEnv = {};
    configureDesktopDistributionEnvironment({
      executablePath: path.join("install", "Paseo.exe"),
      env: upstreamEnv,
      userHome: "user-home",
    });
    expect(upstreamEnv).toEqual({});
  });

  it("preserves explicit test homes and listen overrides", () => {
    const env: NodeJS.ProcessEnv = {
      PASEO_HOME: "isolated-test-home",
      PASEO_LISTEN: "127.0.0.1:54321",
      PORT: "54322",
    };
    configureDesktopDistributionEnvironment({ executablePath: "PaseoAdvanced.exe", env });
    expect(env.PASEO_HOME).toBe("isolated-test-home");
    expect(env.PASEO_LISTEN).toBe("127.0.0.1:54321");
    expect(env.PORT).toBe("54322");
  });

  it("routes Advanced agent links without changing the shared renderer protocol", () => {
    const link = "paseo-advanced://h/server/agent/agent";
    expect(normalizeDesktopAgentLink(link, resolveDesktopDistribution("PaseoAdvanced.exe"))).toBe(
      "paseo://h/server/agent/agent",
    );
    expect(normalizeDesktopAgentLink(link, resolveDesktopDistribution("Paseo.exe"))).toBe(link);
  });
});

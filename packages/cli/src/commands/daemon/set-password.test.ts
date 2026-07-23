import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { setDaemonPasswordInConfig } from "./set-password.js";

describe("setDaemonPasswordInConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("preserves unrecognized fields while updating the password", async () => {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-set-password-"));
    tempDirs.push(paseoHome);
    const configPath = path.join(paseoHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          futureRootSetting: { enabled: true },
          daemon: {
            futureDaemonSetting: "keep",
            auth: {
              futureAuthSetting: "keep",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await setDaemonPasswordInConfig("correct horse battery staple", { home: paseoHome });

    const saved = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const daemon = saved.daemon as Record<string, unknown>;
    const auth = daemon.auth as Record<string, unknown>;
    expect(saved.futureRootSetting).toEqual({ enabled: true });
    expect(daemon.futureDaemonSetting).toBe("keep");
    expect(auth.futureAuthSetting).toBe("keep");
    expect(auth.password).toEqual(expect.stringMatching(/^\$2[aby]\$12\$/));
  });
});

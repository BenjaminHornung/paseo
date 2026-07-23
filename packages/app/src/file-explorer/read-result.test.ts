import { describe, expect, test } from "vitest";
import { explorerFileFromReadResult } from "./read-result";

describe("explorerFileFromReadResult", () => {
  test("preserves optional revision from the daemon read result", () => {
    const result = explorerFileFromReadResult({
      bytes: new TextEncoder().encode("hello"),
      mime: "text/plain",
      size: 5,
      path: "notes.txt",
      kind: "text",
      modifiedAt: "2026-07-23T10:00:00.000Z",
      revision: "rev-1",
    });

    expect(result).toEqual({
      path: "notes.txt",
      kind: "text",
      encoding: "utf-8",
      content: "hello",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-07-23T10:00:00.000Z",
      revision: "rev-1",
    });
  });

  test("keeps older-peer reads undefined-compatible when revision is absent", () => {
    const result = explorerFileFromReadResult({
      bytes: new TextEncoder().encode("hello"),
      mime: "text/plain",
      size: 5,
      path: "notes.txt",
      kind: "text",
      modifiedAt: "2026-07-23T10:00:00.000Z",
    });

    expect(result.revision).toBeUndefined();
  });
});

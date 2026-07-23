import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Clipboard from "expo-clipboard";
import { HighlightedCodeBlock } from "./highlighted-code-block";

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/styles/syntax-token-styles", () => ({ syntaxTokenStyleFor: () => undefined }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface MountedBlock {
  container: HTMLDivElement;
  root: Root;
}

const mounted: MountedBlock[] = [];
const INHERITED_STYLES = {};
const CODE_TEXT_STYLE = { fontFamily: "monospace", fontSize: 14 };

async function renderCodeBlock(code: string, language: string | null): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });

  await act(async () => {
    root.render(
      <HighlightedCodeBlock
        code={code}
        language={language}
        inheritedStyles={INHERITED_STYLES}
        textStyle={CODE_TEXT_STYLE}
      />,
    );
  });

  return container;
}

function renderedRows(container: HTMLElement): HTMLElement[] {
  const surfaces = container.querySelectorAll<HTMLElement>("[data-pmono]");
  const lineSurface = surfaces.item(1);
  if (!lineSurface) throw new Error("Expected nested code-line surface");
  return Array.from(lineSurface.children) as HTMLElement[];
}

function selectedText(element: HTMLElement): string {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const text = selection?.toString() ?? "";
  selection?.removeAllRanges();
  return text;
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  vi.clearAllMocks();
});

describe("HighlightedCodeBlock in a real browser", () => {
  it("renders long, duplicate, and empty plain-code lines independently without wrapping", async () => {
    const longLine = "x".repeat(50_000);
    const container = await renderCodeBlock(`duplicate\n\n${longLine}\nduplicate`, null);
    const rows = renderedRows(container);

    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toBe("duplicate");
    expect(rows[1].getBoundingClientRect().height).toBeGreaterThan(0);
    expect(rows[2].textContent).toBe(longLine);
    expect(rows[3].textContent).toBe("duplicate");
    expect(getComputedStyle(rows[2].firstElementChild!).whiteSpace).toBe("pre");
    expect(getComputedStyle(container.querySelector<HTMLElement>("[data-pmono]")!).overflowX).toBe(
      "auto",
    );
    expect(selectedText(container)).not.toContain("\u200b");
  });

  it("renders highlighted tokens in separate physical rows", async () => {
    const container = await renderCodeBlock("const first = 1;\n\nconst first = 1;", "ts");
    const rows = renderedRows(container);

    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toBe("const first = 1;");
    expect(rows[1].getBoundingClientRect().height).toBeGreaterThan(0);
    expect(rows[2].textContent).toBe("const first = 1;");
    expect(selectedText(container)).not.toContain("\u200b");
  });

  it("copies the exact original code instead of the rendered placeholders", async () => {
    const code = "first\n\nlast\n";
    const container = await renderCodeBlock(code, "ts");
    const copyButton = container.querySelector<HTMLElement>("[role=button]");
    expect(copyButton).not.toBeNull();

    await act(async () => copyButton!.click());

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(code);
  });
});

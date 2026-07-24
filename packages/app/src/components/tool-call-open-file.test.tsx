/**
 * @vitest-environment jsdom
 */
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolCall } from "./message";

vi.mock("@/assistant-file-links", () => ({
  AssistantInlineCodePathLink: ({ children }: { children: React.ReactNode }) => children,
  AssistantMarkdownCodeLink: ({ children }: { children: React.ReactNode }) => children,
  AssistantMarkdownLink: ({ children }: { children: React.ReactNode }) => children,
  useAssistantFileLinkActions: () => ({ open: vi.fn() }),
  useAssistantLinkPress: () => null,
}));

vi.mock("@/attachments/attachment-pill-content", () => ({
  getAgentAttachmentPillContent: () => null,
}));

vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: () => null,
}));

vi.mock("@/components/attachment-pill", () => ({
  AttachmentFrame: ({ children }: { children: React.ReactNode }) => children,
  AttachmentLabel: () => null,
  AttachmentThumbnail: () => null,
}));

vi.mock("@/components/assistant-fork-menu", () => ({
  AssistantForkMenu: () => null,
}));

vi.mock("@/components/rewind/rewind-menu", () => ({
  RewindMenu: () => null,
}));

vi.mock("@/components/rewind/use-rewind-agent-mutation", () => ({
  useRewindAgentMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/components/tool-call-sheet", () => ({
  useToolCallSheet: () => ({ openToolCall: vi.fn() }),
}));

vi.mock("@/components/highlighted-code-block", () => ({
  HighlightedCodeBlock: () => null,
}));

vi.mock("@/components/tool-call-details", () => ({
  ToolCallDetailsContent: () => null,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@react-native-masked-view/masked-view", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("react-native-markdown-display", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  MarkdownIt: () => ({ parse: vi.fn(() => []) }),
}));

vi.mock("expo-clipboard", () => ({}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react-native")>();
  const Icon = () => null;
  return {
    ...actual,
    Check: Icon,
    CheckCircle: Icon,
    CheckSquare: Icon,
    Circle: Icon,
    FileSymlink: Icon,
    MicVocal: Icon,
    Scissors: Icon,
    Sparkles: Icon,
    TriangleAlertIcon: Icon,
  };
});

vi.mock("./plan-card", () => ({
  PlanCard: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  Easing: {
    linear: "linear",
  },
  cancelAnimation: vi.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

vi.mock("react-native-unistyles", () => {
  const theme = {
    colorScheme: "light",
    colors: {
      border: "#e4e4e7",
      destructive: "#b91c1c",
      foreground: "#111111",
      foregroundMuted: "#666666",
      mutedForeground: "#666666",
      primaryForeground: "#ffffff",
      surface1: "#fafafa",
      surface3: "#e4e4e7",
    },
    spacing: [0, 4, 8, 12, 16, 20, 24],
    fontFamily: { mono: "monospace", ui: "sans-serif" },
    fontSize: { xs: 12, sm: 14, base: 16, code: 14 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { sm: 2, base: 4, md: 6, lg: 8, "2xl": 16 },
    borderWidth: [0, 1],
  };

  return {
    StyleSheet: {
      create: (styles: unknown) => (typeof styles === "function" ? styles(theme) : styles),
    },
    UnistylesRuntime: { setTheme: vi.fn(), themeName: "light" },
    useUnistyles: () => ({ theme, rt: {}, breakpoint: undefined }),
    withUnistyles: (Component: unknown) => Component,
  };
});

afterEach(cleanup);

function readDetail(filePath: string): ToolCallDetail {
  return {
    type: "read",
    filePath,
    content: "const value = true;",
  };
}

const DETAIL_WITHOUT_FILE_PATH: ToolCallDetail = {
  type: "unknown",
  input: {},
  output: null,
};

function hoverBadgeAndClickOpenFile(): void {
  fireEvent.pointerEnter(screen.getByTestId("tool-call-badge"));
  fireEvent.click(screen.getByTestId("tool-call-open-file"));
}

describe("ToolCall open-file action", () => {
  it("opens a Windows path at its parsed line", () => {
    const filePath = String.raw`C:\project\src\app.ts:12`;
    const onOpenFileTarget = vi.fn();

    render(
      <ToolCall
        toolName="read_file"
        status="completed"
        detail={readDetail(filePath)}
        onOpenFileTarget={onOpenFileTarget}
        forceInline
      />,
    );

    hoverBadgeAndClickOpenFile();

    expect(onOpenFileTarget).toHaveBeenCalledOnce();
    expect(onOpenFileTarget).toHaveBeenCalledWith({
      raw: filePath,
      path: "C:/project/src/app.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("opens a Windows path at its parsed line range", () => {
    const filePath = String.raw`C:\project\src\app.ts:5-8`;
    const onOpenFileTarget = vi.fn();

    render(
      <ToolCall
        toolName="read_file"
        status="completed"
        detail={readDetail(filePath)}
        onOpenFileTarget={onOpenFileTarget}
        forceInline
      />,
    );

    hoverBadgeAndClickOpenFile();

    expect(onOpenFileTarget).toHaveBeenCalledOnce();
    expect(onOpenFileTarget).toHaveBeenCalledWith({
      raw: filePath,
      path: "C:/project/src/app.ts",
      lineStart: 5,
      lineEnd: 8,
    });
  });

  it("does not show an open-file action when the detail has no file path", () => {
    const onOpenFileTarget = vi.fn();

    render(
      <ToolCall
        toolName="unknown_tool"
        status="completed"
        detail={DETAIL_WITHOUT_FILE_PATH}
        onOpenFileTarget={onOpenFileTarget}
        forceInline
      />,
    );

    fireEvent.pointerEnter(screen.getByTestId("tool-call-badge"));

    expect(screen.queryByTestId("tool-call-open-file")).toBeNull();
    expect(onOpenFileTarget).not.toHaveBeenCalled();
  });
});

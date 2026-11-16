import React, { act, createRef, useCallback, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { ComposerPredictionBinding, type PredictionHandle } from "./binding";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
notifyManager.setNotifyFunction((notify) => act(notify));
afterAll(() => notifyManager.setNotifyFunction((notify) => notify()));

const fixture = vi.hoisted(() => ({
  predict: vi.fn(),
  state: {
    sessions: {
      host: {
        serverInfo: { features: { composerPredictions: true } },
        agentStreamTail: new Map([["chat", [{ kind: "user_message", turnId: "turn-1" }]]]),
      },
    },
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: typeof fixture.state) => unknown) => select(fixture.state),
  selectAgentTurnPresentation: () => ({ isActive: false }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ predictComposerMessage: fixture.predict }),
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: {
      composerPredictions: { enabled: true, profileId: "prediction" },
      agentProfiles: [{ id: "prediction", name: "Prediction", provider: "claude" }],
    },
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (
      factory: (theme: {
        spacing: Record<number, number>;
        colors: { foregroundMuted: string };
        fontSize: { sm: number };
      }) => unknown,
    ) =>
      factory({ spacing: { 2: 8 }, colors: { foregroundMuted: "#555555" }, fontSize: { sm: 12 } }),
  },
}));

function textSource() {
  let text = "";
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => text,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (value: string) => {
      text = value;
      for (const listener of listeners) listener();
    },
  };
}

function Harness({ source }: { source: ReturnType<typeof textSource> }) {
  const value = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const ref = createRef<PredictionHandle>();
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => source.set(event.target.value),
    [source],
  );
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      ref.current?.onKeyPress({
        key: event.key,
        hasModifier: event.shiftKey || event.ctrlKey || event.altKey || event.metaKey,
        input: { text: source.getSnapshot() },
        preventDefault: () => event.preventDefault(),
      });
    },
    [ref, source],
  );
  return (
    <>
      <textarea value={value} onChange={onChange} onKeyDown={onKeyDown} />
      <ComposerPredictionBinding
        ref={ref}
        serverId="host"
        agentId="chat"
        text={source}
        accept={source.set}
        enabled
      />
    </>
  );
}

async function mount(source: ReturnType<typeof textSource>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Harness source={source} />
      </QueryClientProvider>,
    ),
  );
  onTestFinished(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Composer input missing");
  return { container, input };
}

it("Tab turns the suggestion into an editable draft and prevents default keyboard handling", async () => {
  let complete!: (value: { suggestion: string; error: null }) => void;
  fixture.predict.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const source = textSource();
  const { container, input } = await mount(source);
  await vi.waitFor(() => expect(fixture.predict).toHaveBeenCalledTimes(1));
  await act(async () => complete({ suggestion: "ja, bitte umsetzen", error: null }));
  await vi.waitFor(() => expect(container.textContent).toContain("ja, bitte umsetzen"));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(true);
  expect(input.value).toBe("ja, bitte umsetzen");
  expect(fixture.predict).toHaveBeenCalledTimes(1);
  act(() => source.set("mein geänderter entwurf"));
  expect(input.value).toBe("mein geänderter entwurf");
});

it("a late prediction cannot replace text the user has already entered", async () => {
  let complete!: (value: { suggestion: string; error: null }) => void;
  fixture.predict.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const source = textSource();
  const { container, input } = await mount(source);
  await vi.waitFor(() => expect(fixture.predict).toHaveBeenCalledTimes(1));
  act(() => source.set("mein eigener text"));
  await act(async () => complete({ suggestion: "überschreib das", error: null }));
  expect(container.textContent).not.toContain("überschreib das");
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(false);
  expect(input.value).toBe("mein eigener text");
});

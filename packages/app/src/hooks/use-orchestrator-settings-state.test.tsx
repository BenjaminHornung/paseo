/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginPaseoApi } from "@getpaseo/plugin/client";
import {
  PaseoApiProvider,
  PluginRpcProvider,
  type PluginSubscribe,
} from "@getpaseo/plugin/client/host";
import { useSettingsState } from "../../../orchestrator/paseo-plugin/client/settings-state";
import {
  loadSettings,
  saveSettings,
  type ControllerConfig,
  type SettingsView,
} from "../../../orchestrator/paseo-plugin/shared/settings";

const settingsKey = ["orchestrator-settings"];

function config(): ControllerConfig {
  return {
    schemaVersion: 1,
    daemonUrl: "ws://127.0.0.1:6767/ws",
    gitExecutable: "git",
    maxWorkflows: 1,
    maxRework: 0,
    apiEnabled: false,
    liveDispatchApproved: false,
    routes: [
      {
        id: "route",
        access: "codex-pro200",
        provider: "codex",
        model: "gpt-6",
        revision: "route-revision",
        reasoning: "high",
        tier: 1,
        enabled: false,
        maxConcurrent: 1,
        capabilities: ["code"],
      },
    ],
    budgets: { decisions: 0, implementation: 0, "premium-api": 0, emergency: 0 },
  };
}

function view(revision: string, settings: ControllerConfig): SettingsView {
  return {
    revision,
    config: settings,
    controllerRoot: "",
    credentials: {
      normal: { present: false, source: "missing", revision: "normal-revision" },
      decisions: { present: false, source: "missing", revision: "decisions-revision" },
    },
    usage: { cycle: "2026-11", committedMicroUsd: 0, unknownCalls: 0, calls: 0 },
    circuits: [],
    dispatchPaused: false,
    activeAttempts: 0,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function approveLiveDispatch(current: ControllerConfig): ControllerConfig {
  return { ...current, liveDispatchApproved: true };
}

function setOneMaxRework(current: ControllerConfig): ControllerConfig {
  return { ...current, maxRework: 1 };
}

function createSettingsRpcBackend(initialView: SettingsView, savedViewB: SettingsView) {
  const firstSave = deferred<SettingsView>();
  const firstSaveStarted = deferred<void>();
  const detachedSaveStarted = deferred<void>();
  const saveCalls: Array<{ revision: string; config: Record<string, unknown> }> = [];
  let serverView = initialView;

  const invoke: Parameters<typeof PluginRpcProvider>[0]["invoke"] = async (method, input) => {
    if (method === loadSettings.name) return serverView;
    if (method !== saveSettings.name) throw new Error(`Unexpected RPC: ${method}`);

    const request = saveSettings.input.parse(input);
    saveCalls.push(request);
    if (saveCalls.length === 1) {
      firstSaveStarted.resolve();
      serverView = await firstSave.promise;
      return serverView;
    }

    detachedSaveStarted.resolve();
    serverView = savedViewB;
    return serverView;
  };

  return {
    invoke,
    firstSaveStarted: firstSaveStarted.promise,
    resolveFirstSave: firstSave.resolve,
    detachedSaveStarted: detachedSaveStarted.promise,
    saveCalls,
    serverView: () => serverView,
  };
}

const paseo = {} as PluginPaseoApi;
const noSubscribe: PluginSubscribe = () =>
  Object.assign(() => undefined, { ready: Promise.resolve(), release: () => Promise.resolve() });

afterEach(() => vi.useRealTimers());

describe("orchestrator settings autosave", () => {
  it("keeps the detached edit in cache when the earlier save completes after unmount", async () => {
    const initialConfig = config();
    const configA = { ...initialConfig, liveDispatchApproved: true };
    const configB = { ...configA, maxRework: 1 };
    const initialView = view("revision-0", initialConfig);
    const savedViewA = view("revision-a", configA);
    const savedViewB = view("revision-b", configB);
    const rpc = createSettingsRpcBackend(initialView, savedViewB);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(settingsKey, initialView);

    function wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <PaseoApiProvider paseo={paseo}>
            <PluginRpcProvider invoke={rpc.invoke} subscribe={noSubscribe}>
              {children}
            </PluginRpcProvider>
          </PaseoApiProvider>
        </QueryClientProvider>
      );
    }

    const { result, unmount } = renderHook(() => useSettingsState("routes"), { wrapper });
    await waitFor(() => expect(result.current.view).toEqual(initialView));

    vi.useFakeTimers();
    act(() => result.current.change(approveLiveDispatch));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await rpc.firstSaveStarted;

    act(() => result.current.change(setOneMaxRework));
    act(() => unmount());
    vi.useRealTimers();

    rpc.resolveFirstSave(savedViewA);
    await rpc.detachedSaveStarted;
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(rpc.saveCalls).toEqual([
      { revision: "revision-0", config: configA },
      { revision: "revision-a", config: configB },
    ]);
    expect(rpc.serverView()).toEqual(savedViewB);

    const reopened = renderHook(() => useSettingsState("routes"), { wrapper });
    await waitFor(() => expect(reopened.result.current.view).toEqual(savedViewB));
    expect(queryClient.getQueryData(settingsKey)).toEqual(savedViewB);
    reopened.unmount();
    queryClient.clear();
  });
});

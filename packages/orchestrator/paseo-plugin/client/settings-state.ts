import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadSettings,
  saveSettings,
  saveCredential,
  pauseDispatch,
  testDecisions,
  type ControllerConfig,
  type SettingsView,
} from "../shared/settings";
import {
  summarizeErrors,
  validateSettings,
  type SettingsErrors,
} from "../shared/settings-validation";

export type Tab = "routes" | "decisions" | "keys";
const autosaveDelayMs = 600;
const messages: [string, string][] = [
  [
    "SETTINGS_CONFLICT",
    "In einem anderen Fenster geändert. Die Einstellungen wurden neu geladen; bitte die letzte Änderung erneut vornehmen.",
  ],
  [
    "PI_CREDENTIALS_BUSY",
    "Pi aktualisiert gerade seine Zugangsdaten. Bitte gleich erneut versuchen.",
  ],
  ["DECISIONS_KEY_MISSING", "Zuerst unter Keys & Budgets den separaten Decisions-Key speichern."],
  [
    "ROUTE_NOT_SUPPORTED",
    "Eine aktivierte Route nutzt ein Modell, eine Reasoning-Stufe oder einen Berechtigungsmodus, den der Provider gerade nicht anbietet. Route anpassen oder deaktivieren.",
  ],
  [
    "SECRETS_NOT_CONFIG_VALUES",
    "Ein Feld enthält einen API-Key. Keys nur unter Keys & Budgets speichern.",
  ],
  [
    "protected reserve twice",
    "Das Decisions-Monatsbudget übersteigt das Controller-Budget „decisions“.",
  ],
  [
    "unknown route",
    "Eine Rollen- oder Kategoriezuordnung verweist auf eine nicht vorhandene Route.",
  ],
];
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = messages.find(([needle]) => message.includes(needle));
  if (known) return known[1];
  let code = "UNKNOWN";
  if (typeof error === "object" && error !== null && "safeCode" in error)
    code = String(error.safeCode);
  else if (/^[A-Z0-9_]{1,70}$/.test(message)) code = message;
  return `Aktion fehlgeschlagen (${/^[A-Z0-9_-]{1,50}$/.test(code) ? code : "UNKNOWN"}). Bitte erneut versuchen oder Einstellungen neu laden.`;
}

function statusText(input: {
  saving: boolean;
  dirty: boolean;
  errors: SettingsErrors;
  error: string;
}): string {
  if (input.saving) return "Speichert…";
  if (!input.dirty) return "Gespeichert";
  if (Object.keys(input.errors).length)
    return `Nicht gespeichert: ${summarizeErrors(input.errors)}`;
  return input.error ? "Nicht gespeichert" : "Speichert…";
}

/**
 * Owns the settings draft and its autosave. Every edit goes through `change`, which
 * schedules one save ~600 ms after the last edit. Invalid drafts stay local and surface
 * per-field messages; the server revision check stays authoritative.
 */
export function useSettingsState(initialTab: Tab) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const load = useRpc(loadSettings),
    save = useRpc(saveSettings),
    credential = useRpc(saveCredential),
    pause = useRpc(pauseDispatch),
    test = useRpc(testDecisions);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<ControllerConfig>();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const draftRef = useRef<ControllerConfig | undefined>(undefined);
  const dirtyRef = useRef(false);
  const viewRef = useRef<SettingsView | undefined>(undefined);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushRef = useRef<() => void>(() => undefined);
  const saveRef = useRef(save);
  saveRef.current = save;
  const normalRef = useRef<SettingsInputHandle>(null),
    decisionsRef = useRef<SettingsInputHandle>(null);
  const [normalReady, setNormalReady] = useState(false),
    [decisionsReady, setDecisionsReady] = useState(false);
  useEffect(() => {
    setNormalReady(false);
    setDecisionsReady(false);
    normalRef.current?.replaceText("");
    decisionsRef.current?.replaceText("");
  }, [tab]);
  const settings = useQuery({
    queryKey: ["orchestrator-settings"],
    queryFn: () => load({}),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ["orchestrator-catalog", view?.controllerRoot],
    enabled: !!view?.controllerRoot,
    queryFn: async () => {
      const [providers, config] = await Promise.all([
        paseo.providers.waitForReady({ cwd: view!.controllerRoot }),
        paseo.config.get(),
      ]);
      return { providers: providers.entries, profiles: config.config.agentProfiles ?? [] };
    },
    retry: false,
  });
  const accept = useCallback(
    (result: unknown, replaceDraft: boolean) => {
      const next = result as SettingsView;
      // Plugin surfaces can remount on theme changes or reopening settings.
      // Seed them from the last confirmed server view, not the initial query.
      queryClient.setQueryData(["orchestrator-settings"], next);
      const replace = replaceDraft || !dirtyRef.current;
      setView((previous) => {
        const merged = !replace && previous ? { ...next, revision: previous.revision } : next;
        viewRef.current = merged;
        return merged;
      });
      if (replace) {
        draftRef.current = next.config;
        setDraft(next.config);
        dirtyRef.current = false;
        setDirty(false);
        setGeneration((v) => v + 1);
      }
      setError("");
    },
    [queryClient],
  );
  useEffect(() => {
    if (settings.data && !view) accept(settings.data, true);
  }, [settings.data, view, accept]);
  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushRef.current(), autosaveDelayMs);
  }, []);
  const reloadAfterConflict = (conflict: unknown) => {
    // Another window saved first: take the server state and tell the user.
    load({})
      .then((value) => {
        accept(value, true);
        setError(safeError(conflict));
        return value;
      })
      .catch((reloadError: unknown) => setError(safeError(reloadError)));
  };
  const saveMutation = useMutation({
    mutationFn: async (config: ControllerConfig) => {
      savingRef.current = true;
      return save({
        revision: viewRef.current!.revision,
        config: config as unknown as Record<string, unknown>,
      });
    },
    onSuccess: (value, sent) => {
      const next = value as unknown as SettingsView;
      queryClient.setQueryData(["orchestrator-settings"], next);
      viewRef.current = next;
      setView(next);
      setError("");
      if (draftRef.current === sent) {
        dirtyRef.current = false;
        setDirty(false);
      } else scheduleSave();
    },
    onError: (e) => {
      if (e instanceof Error && e.message.includes("SETTINGS_CONFLICT")) reloadAfterConflict(e);
      else setError(safeError(e));
    },
    onSettled: () => {
      savingRef.current = false;
    },
  });
  const credentialMutation = useMutation({
    mutationFn: (slot: "normal" | "decisions") =>
      credential({
        slot,
        key:
          slot === "normal"
            ? (normalRef.current?.getText() ?? "")
            : (decisionsRef.current?.getText() ?? ""),
        revision: view!.credentials[slot].revision,
      }),
    onSuccess: (value, slot) => {
      if (slot === "normal") {
        setNormalReady(false);
        normalRef.current?.replaceText("");
      } else {
        setDecisionsReady(false);
        decisionsRef.current?.replaceText("");
      }
      accept(value, false);
    },
    onError: (e) => setError(safeError(e)),
  });
  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) => pause({ paused }),
    onSuccess: (value) => accept(value, false),
    onError: (e) => setError(safeError(e)),
  });
  const testMutation = useMutation({
    mutationFn: () => test({ nonce: `${Date.now()}_${Math.random().toString(36).slice(2)}` }),
    onError: (e) => setError(safeError(e)),
  });
  const reloadMutation = useMutation({
    mutationFn: () => load({}),
    onSuccess: (value) => accept(value, true),
    onError: (e) => setError(safeError(e)),
  });
  const busy =
    saveMutation.isPending ||
    credentialMutation.isPending ||
    pauseMutation.isPending ||
    reloadMutation.isPending ||
    testMutation.isPending;
  const change = useCallback(
    (fn: (current: ControllerConfig) => ControllerConfig) => {
      if (draftRef.current) {
        const next = fn(draftRef.current);
        draftRef.current = next;
        setDraft(next);
      }
      dirtyRef.current = true;
      setDirty(true);
      setError("");
      scheduleSave();
    },
    [scheduleSave],
  );
  flushRef.current = () => {
    timerRef.current = undefined;
    const config = draftRef.current,
      current = viewRef.current;
    if (!config || !current || !dirtyRef.current || savingRef.current) return;
    const problems = validateSettings(config, {
      decisionsKeyPresent: current.credentials.decisions.present,
    });
    if (Object.keys(problems).length) return;
    saveMutation.mutate(config);
  };
  useEffect(
    () => () => {
      // Closing the screen inside the debounce window must not lose the last edit.
      if (timerRef.current) clearTimeout(timerRef.current);
      const config = draftRef.current,
        current = viewRef.current;
      if (!config || !current || !dirtyRef.current || savingRef.current) return;
      const problems = validateSettings(config, {
        decisionsKeyPresent: current.credentials.decisions.present,
      });
      if (Object.keys(problems).length) return;
      saveRef
        .current({
          revision: current.revision,
          config: config as unknown as Record<string, unknown>,
        })
        .catch(() => undefined);
    },
    [],
  );
  const errors = draft
    ? validateSettings(draft, { decisionsKeyPresent: !!view?.credentials.decisions.present })
    : {};
  return {
    tab,
    setTab,
    view,
    draft,
    dirty,
    error,
    setError,
    generation,
    settings,
    catalog,
    errors,
    change,
    busy,
    status: statusText({ saving: saveMutation.isPending, dirty, errors, error }),
    normalRef,
    decisionsRef,
    normalReady,
    setNormalReady,
    decisionsReady,
    setDecisionsReady,
    credentialMutation,
    pauseMutation,
    testMutation,
    reloadMutation,
  };
}
export type SettingsState = ReturnType<typeof useSettingsState>;
/** State once the first settings view has loaded. */
export type ReadySettings = Omit<SettingsState, "view" | "draft"> & {
  view: SettingsView;
  draft: ControllerConfig;
};

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import type { ComposerTextSource } from "../text-source";

interface PredictionKeyEvent {
  key: string;
  hasModifier: boolean;
  preventDefault: () => void;
  input: { text: string };
}
export interface PredictionHandle {
  onKeyPress: (event: PredictionKeyEvent) => boolean;
}

export function ComposerPredictionBinding({
  serverId,
  agentId,
  text,
  accept,
  enabled,
  ref,
}: {
  serverId: string;
  agentId: string;
  text: ComposerTextSource;
  accept: (text: string) => void;
  enabled: boolean;
  ref: Ref<PredictionHandle>;
}) {
  const { t } = useTranslation();
  const value = useSyncExternalStore(text.subscribe, text.getSnapshot, text.getSnapshot);
  const client = useHostRuntimeClient(serverId);
  const { config } = useDaemonConfig(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.composerPredictions === true,
  );
  const active = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[serverId], agentId).isActive,
  );
  const sourceTurnId = useSessionStore((state) => {
    const items = state.sessions[serverId]?.agentStreamTail.get(agentId);
    if (!items) return null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if ("turnId" in item && item.turnId) return item.turnId;
    }
    return null;
  });
  const settings = config?.composerPredictions;
  const profile = config?.agentProfiles?.find((entry) => entry.id === settings?.profileId);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const identity = JSON.stringify([agentId, sourceTurnId, profile, config?.providers]);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!settings?.enabled)
      queryClient.removeQueries({ queryKey: ["composer-prediction", serverId] });
  }, [queryClient, serverId, settings?.enabled]);
  const visible =
    enabled &&
    supported &&
    !!profile &&
    !!sourceTurnId &&
    settings?.enabled &&
    !active &&
    value === "" &&
    dismissed !== identity;
  const query = useFetchQuery({
    queryKey: ["composer-prediction", serverId, identity],
    enabled: visible,
    dataShape: "value",
    immutableWhen: () => true,
    retry: (attempt, error) => error.message === "unavailable" && attempt < 2,
    retryDelay: 5_000,
    queryFn: async () => {
      if (!client || !sourceTurnId) throw new Error("Prediction unavailable");
      const result = await client.predictComposerMessage({ agentId, sourceTurnId });
      if (result.error) throw new Error(result.error);
      return result.suggestion;
    },
  });
  const suggestion = visible ? query.data : null;
  const retryPrediction = useCallback(() => void query.refetch(), [query]);
  const dismissPrediction = useCallback(() => setDismissed(identity), [identity]);
  const acceptSuggestion = useCallback(() => {
    if (!suggestion || text.getSnapshot() !== "") return;
    setDismissed(identity);
    accept(suggestion);
  }, [suggestion, text, identity, accept]);
  useImperativeHandle(
    ref,
    () => ({
      onKeyPress(event) {
        if (!suggestion || event.input.text !== "" || event.hasModifier) return false;
        if (event.key === "Escape") {
          event.preventDefault();
          setDismissed(identity);
          return true;
        }
        if (event.key !== "Tab") return false;
        event.preventDefault();
        acceptSuggestion();
        return true;
      },
    }),
    [suggestion, identity, acceptSuggestion],
  );
  if (!visible) return null;
  if (query.isError)
    return (
      <View style={styles.row}>
        <Text style={styles.hint}>{t("composer.predictions.failed")}</Text>
        <Button variant="ghost" onPress={retryPrediction}>
          {t("common.retry")}
        </Button>
      </View>
    );
  if (!suggestion) return null;
  return (
    <View style={styles.row} testID="composer-prediction">
      <Text style={styles.hint}>{suggestion}</Text>
      <Button variant="ghost" onPress={acceptSuggestion}>
        {t("composer.predictions.accept")}
      </Button>
      <Button variant="ghost" onPress={dismissPrediction}>
        {t("composer.predictions.dismiss")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: theme.spacing[2], padding: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

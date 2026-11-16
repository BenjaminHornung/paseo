import { useCallback, useMemo, type RefObject } from "react";
import type { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DraftCommandTarget } from "@/agent-commands";
import type { HarnessContextEntry } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { useHarnessContext } from "./query";

export function HarnessContextPicker({
  serverId,
  agentId,
  draft,
  anchorRef,
  open,
  onOpenChange,
  onSelect,
}: {
  serverId: string;
  agentId: string;
  draft?: DraftCommandTarget;
  anchorRef: RefObject<View | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (entry: HarnessContextEntry) => void;
}) {
  const { t } = useTranslation();
  const query = useHarnessContext(serverId, agentId, open, draft);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const select = useCallback(
    (id: string) => {
      const entry = query.data?.entries.find((candidate) => candidate.id === id);
      if (entry) onSelect(entry);
    },
    [query.data, onSelect],
  );
  const options = useMemo(
    () =>
      (query.data?.entries ?? []).map((entry) => ({
        id: entry.id,
        label: entry.name,
        description: `${t(`composer.context.${entry.kind}`)} · ${entry.description}`,
      })),
    [query.data, t],
  );
  const failed = query.isError || !!query.data?.error;
  const footer = useMemo(
    () =>
      failed ? (
        <Button variant="ghost" onPress={retry}>
          {t("common.retry")}
        </Button>
      ) : undefined,
    [failed, retry, t],
  );
  let emptyText = t("composer.context.empty");
  if (failed) emptyText = t("composer.context.failed");
  if (query.isFetching) emptyText = t("composer.context.loading");
  return (
    <Combobox
      anchorRef={anchorRef}
      open={open}
      onOpenChange={onOpenChange}
      options={options}
      value=""
      searchable
      title={t("composer.context.title")}
      searchPlaceholder={t("composer.context.search")}
      emptyText={emptyText}
      footer={footer}
      onSelect={select}
    />
  );
}

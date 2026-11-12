import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAgentProfiles } from "@/agent-profiles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Combobox } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { settingsStyles } from "@/styles/settings";

const DEFAULT_PREDICTION_SETTINGS = { enabled: false, profileId: null };

export function ComposerPredictionSettings({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(serverId);
  const providers = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.composerPredictions === true,
  );
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View | null>(null);
  const settings = config?.composerPredictions ?? DEFAULT_PREDICTION_SETTINGS;
  const save = useCallback(
    async (next: typeof settings) => {
      setSaving(true);
      setFailed(false);
      try {
        const saved = await patchConfig({ composerPredictions: next });
        if (!saved) setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        setSaving(false);
      }
    },
    [patchConfig],
  );
  const supportedProfiles = (profiles ?? []).filter((profile) =>
    (providers.entries ?? []).some(
      (entry) =>
        entry.provider === profile.provider && entry.capabilities?.supportsTextGeneration === true,
    ),
  );
  const selected = supportedProfiles.find((profile) => profile.id === settings.profileId);
  const options = supportedProfiles.map((profile) => ({ id: profile.id, label: profile.name }));
  const unavailable = settings.profileId !== null && !selected;
  const changeEnabled = useCallback(
    (enabled: boolean) => void save({ ...settings, enabled }),
    [save, settings],
  );
  const selectProfile = useCallback(
    (profileId: string) => void save({ ...settings, profileId }),
    [save, settings],
  );
  const openProfiles = useCallback(() => setOpen(true), []);
  if (!supported) return null;
  return (
    <SettingsSection title={t("composer.predictions.title")}>
      <SettingsCard>
        <SettingsRow
          label={t("composer.predictions.enabled")}
          hint={t("composer.predictions.description")}
        >
          <Switch
            value={settings.enabled}
            onValueChange={changeEnabled}
            disabled={saving || !config || (!selected && !settings.enabled)}
            accessibilityLabel={t("composer.predictions.enabled")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("composer.predictions.profile")}
          hint={t("composer.predictions.profileHint")}
        >
          <Combobox
            options={options}
            value={settings.profileId ?? ""}
            onSelect={selectProfile}
            placeholder={t("composer.predictions.chooseProfile")}
            anchorRef={anchorRef}
            open={open}
            onOpenChange={setOpen}
            searchable
          >
            <ComboboxTrigger ref={anchorRef} disabled={saving || !config} onPress={openProfiles}>
              <Text>{selected?.name ?? t("composer.predictions.chooseProfile")}</Text>
            </ComboboxTrigger>
          </Combobox>
        </SettingsRow>
        {unavailable ? (
          <Text style={settingsStyles.rowHint}>{t("composer.predictions.unavailable")}</Text>
        ) : null}
        {failed ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowHint}>
            {t("composer.predictions.saveFailed")}
          </Text>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

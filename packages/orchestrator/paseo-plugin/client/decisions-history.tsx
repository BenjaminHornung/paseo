import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { decisionsHistory } from "../shared/decisions-history";
import { CompactAction } from "./compact-action";

const labels: Record<string, string> = {
  intent: "Intention",
  needExplorer: "Recherche",
  needPlanner: "Planer",
  needAdvisor: "Advisor",
  needImplementation: "Implementierung",
  extraReviewRecommended: "Zusätzliches Review",
  complexity: "Komplexität",
  additionalPlanning: "Weitere Planung",
  advisorNeeded: "Advisor",
  shouldSplit: "Paket aufteilen",
};
function TraceText({
  title,
  value,
  theme,
}: {
  title: string;
  value: string;
  theme: PluginSurfaceProps["theme"];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <Text style={{ fontWeight: "600", fontSize: 13, color: theme.colors.foreground }}>
        {title}
      </Text>
      <Text
        selectable
        style={{ fontSize: 12, lineHeight: 17, color: theme.colors.foregroundMuted }}
      >
        {expanded ? value : value.slice(0, 800)}
        {!expanded && value.length > 800 ? "\n… gekürzte Ansicht" : ""}
      </Text>
      {value.length > 800 && (
        <CompactAction
          theme={theme}
          label={expanded ? "Kürzer anzeigen" : "Vollständig anzeigen"}
          icon={expanded ? "ChevronUp" : "ChevronDown"}
          onPress={() => setExpanded(!expanded)}
        />
      )}
    </View>
  );
}

export function DecisionsHistory(
  props: PluginSurfaceProps & { directory: string; agentId: string },
) {
  const load = useRpc(decisionsHistory);
  const [before, setBefore] = useState<number>(),
    [selected, setSelected] = useState<string>();
  const query = useQuery({
    queryKey: ["decisions-history", props.agentId, props.directory, before],
    retry: false,
    queryFn: () => load({ directory: props.directory, agentId: props.agentId, before }),
  });
  const items = query.data?.items ?? [],
    id = items.some((item) => item.id === selected) ? selected : items[0]?.id;
  const detailQuery = useQuery({
    queryKey: ["decision-detail", props.agentId, id],
    enabled: !!id,
    retry: false,
    queryFn: () => load({ directory: props.directory, agentId: props.agentId, assessmentId: id }),
  });
  const index = items.findIndex((item) => item.id === id),
    item = items[index],
    detail = detailQuery.data?.detail;
  const colors = props.theme.colors;
  const plain = (text: string) => (
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{text}</Text>
  );
  let modelAnswers: unknown;
  if (detail?.response || detail?.diagnostics) {
    const parsed = JSON.parse(detail.response ?? detail.diagnostics!);
    modelAnswers = Array.isArray(parsed) ? parsed : parsed?.answers;
  }
  return (
    <View style={{ gap: 10 }}>
      {plain(
        "Lokal gespeichert · keine erneuten Modellaufrufe. Erkannte Secrets werden ausgeblendet; beliebige unmarkierte Zugangsdaten sind nicht zuverlässig erkennbar. Modellantwort und Controller-Ergebnis können voneinander abweichen.",
      )}
      {query.isPending && <Loading />}
      {query.isError && plain("Verlauf konnte nicht geladen werden. Abschnitt erneut öffnen.")}
      {!query.isPending &&
        !query.isError &&
        !items.length &&
        plain("Noch keine Klassifizierungen für diesen Hauptchat.")}
      {item && (
        <>
          <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>
            {item.kind === "intake" ? "Benutzernachricht" : "Arbeitspaket"} ·{" "}
            {new Date(item.at).toLocaleString()}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            <CompactAction
              theme={props.theme}
              label="Neuer"
              icon="ChevronLeft"
              disabled={index <= 0}
              onPress={() => setSelected(items[index - 1].id)}
            />
            {plain(`${index + 1} / ${items.length}`)}
            <CompactAction
              theme={props.theme}
              label="Älter"
              icon="ChevronRight"
              disabled={index >= items.length - 1}
              onPress={() => setSelected(items[index + 1].id)}
            />
            {query.data?.nextBefore && (
              <CompactAction
                theme={props.theme}
                label="Ältere 20 laden"
                onPress={() => {
                  setSelected(undefined);
                  setBefore(query.data!.nextBefore);
                }}
              />
            )}
            {before && (
              <CompactAction
                theme={props.theme}
                label="Zum neuesten"
                onPress={() => {
                  setSelected(undefined);
                  setBefore(undefined);
                }}
              />
            )}
          </View>
          {detailQuery.isPending && <Loading />}
          {detailQuery.isError && plain("Details konnten nicht geladen werden.")}
          {detail && (
            <>
              <Text
                style={{
                  color: detail.source === "fallback" ? colors.statusWarning : colors.foreground,
                  fontSize: 13,
                }}
              >
                {detail.source === "decisions"
                  ? "Decisions-Ergebnis"
                  : detail.source === "fallback"
                    ? "Controller-Fallback"
                    : "Noch offen"}{" "}
                · {detail.reason}
              </Text>
              {plain(
                detail.provenance === "REQUEST_ATTEMPT_RECORDED"
                  ? "Request-Versuch mit Modell, Fragen und Konfidenzgrenze protokolliert. Ein unklarer Ausgang beweist keinen Empfang."
                  : detail.provenance === "NO_API_CALL"
                    ? "Kein API-Aufruf; lokale Controller-Entscheidung."
                    : "API-Reservierung vorhanden; vollständige Request-Metadaten wurden nicht gespeichert. Bei PENDING/UNKNOWN bleibt der tatsächliche Ausgang unklar.",
              )}
              <TraceText
                title="1 · Eingabefakten (bereinigte Ansicht)"
                value={detail.input}
                theme={props.theme}
              />
              <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>
                2 ·{" "}
                {detail.response
                  ? "Ursprüngliche Modellantworten"
                  : "Gespeicherte Diagnose (ohne Verweigerungen)"}
              </Text>
              {Array.isArray(modelAnswers)
                ? modelAnswers.map((answer, answerIndex) => {
                    const name =
                      typeof answer?.name === "string" ? answer.name : "Unbenannte Frage";
                    const value =
                      answer?.type === "refusal" ? "Verweigert" : (answer?.choice ?? answer?.value);
                    const confidence =
                      typeof answer?.confidence === "number"
                        ? ` · ${(answer.confidence * 100).toFixed(1)} % Konfidenz`
                        : "";
                    return (
                      <Text
                        key={answerIndex}
                        style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}
                      >
                        {labels[name] ?? name}:{" "}
                        {typeof value === "boolean" ? (value ? "Ja" : "Nein") : String(value)}
                        {confidence}
                      </Text>
                    );
                  })
                : plain(
                    "Keine gültige Modellantwort gespeichert. Dies ist keine ablehnende Antwort des Modells.",
                  )}
              <TraceText
                title="3 · Wirksames Controller-Ergebnis"
                value={detail.result ?? "Noch nicht abgeschlossen"}
                theme={props.theme}
              />
              {plain(
                "Verbindliche Reviews und Schreibgates gelten zusätzlich. Decisions bestimmt keine Modellroute; dafür gilt deine gespeicherte Priorität.",
              )}
              {detail.request && (
                <TraceText
                  title="Fragen, Modell & Request-Metadaten"
                  value={detail.request}
                  theme={props.theme}
                />
              )}
              {detail.response && (
                <TraceText
                  title="Gespeicherte Antwortdetails"
                  value={detail.response}
                  theme={props.theme}
                />
              )}
              {plain(
                `API-Status: ${detail.callState} · reserviert ${(detail.reservedMicroUsd / 1e6).toFixed(6)} USD · verbucht ${detail.chargedMicroUsd === null ? "unbekannt" : `${(detail.chargedMicroUsd / 1e6).toFixed(6)} USD`}`,
              )}
              {plain(`Klassifizierung: ${detail.id}\nInput-Hash: ${detail.inputHash}`)}
            </>
          )}
        </>
      )}
    </View>
  );
}

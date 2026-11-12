import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { approveIntake, type IntakeApprovalView } from "../shared/decisions-history";
import { CompactAction } from "./compact-action";

export function IntakeConfirmationAction(props: {
  theme: PluginSurfaceProps["theme"];
  directory: string;
  agentId: string;
  assessmentId: string;
  approval?: IntakeApprovalView;
  onApproved(): void;
}) {
  const approve = useRpc(approveIntake);
  const [reviewed, setReviewed] = useState<string>();
  const context = JSON.stringify([props.assessmentId, props.approval]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!props.approval) throw Error("INTAKE_MODEL_ANSWER_NOT_APPROVABLE");
      const reply = props.approval.confirmation;
      return approve({
        agentId: props.agentId,
        directory: props.directory,
        assessmentId: props.assessmentId,
        messageId: props.approval.messageId,
        confirmation: reply
          ? {
              assessmentId: reply.assessmentId,
              messageId: reply.messageId,
              assessmentHash: reply.assessmentHash,
            }
          : undefined,
      });
    },
    onSuccess: props.onApproved,
  });
  const onPress = useCallback(() => {
    if (reviewed === context) mutation.mutate();
    else setReviewed(context);
  }, [context, reviewed, mutation]);
  const styles = useMemo(
    () => ({
      box: { gap: 8 },
      text: { color: props.theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    }),
    [props.theme],
  );
  if (!props.approval) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.text}>
        Du bestätigst die Modellbewertung für den ursprünglichen Auftrag. Die folgende Antwort
        gehört ausschließlich zu dieser Bestätigung. Kein Taskstart und keine Budgeterhöhung.
      </Text>
      {props.approval.confirmation && (
        <Text selectable style={styles.text}>
          {props.approval.confirmation.input}
        </Text>
      )}
      <CompactAction
        theme={props.theme}
        label={
          reviewed === context
            ? "Ja, genau diese Intake-Bewertung bestätigen"
            : "Modellbewertung bestätigen…"
        }
        disabled={mutation.isPending || mutation.isSuccess}
        onPress={onPress}
      />
      {mutation.isError && (
        <Text style={styles.text}>Bestätigung gesperrt: {mutation.error.message}</Text>
      )}
      {mutation.isSuccess && (
        <Text style={styles.text}>
          Bewertung bestätigt. Task-, Review- und Budgetgates gelten weiterhin.
        </Text>
      )}
    </View>
  );
}

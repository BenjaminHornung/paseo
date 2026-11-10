import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const taskStatusSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  role: z.string(),
  state: z.string(),
  objective: z.string().optional(),
  completionReason: z.string().nullable().optional(),
  attemptState: z.string().nullable(),
  agentId: z.string().nullable(),
  errorKind: z.string().nullable().optional(),
  automatic: z.boolean(),
  classification: z
    .object({
      complexity: z.string(),
      source: z.string(),
      reason: z.string(),
      additionalPlanning: z.boolean(),
      advisorNeeded: z.boolean(),
      shouldSplit: z.boolean(),
      extraReviewRecommended: z.boolean(),
    })
    .optional(),
  plan: z
    .object({
      steps: z.array(z.string()),
      acceptance: z.array(z.string()),
      workPackages: z.array(z.record(z.string(), z.json())).optional(),
    })
    .optional(),
  route: z.object({ name: z.string(), model: z.string(), reasoning: z.string() }).nullable(),
  routing: z
    .object({
      source: z.string(),
      reason: z.string(),
      confidence: z.number().optional(),
      skipped: z.array(z.object({ routeId: z.string(), reason: z.string() })).optional(),
    })
    .nullable(),
  review: z
    .object({
      state: z.string(),
      agentId: z.string().nullable(),
      model: z.string(),
      reasoning: z.string(),
    })
    .nullable(),
  checks: z
    .object({
      build: z.number(),
      test: z.number(),
      diff: z.number(),
      scopeViolations: z.number(),
      changed: z.boolean(),
    })
    .nullable(),
  events: z.array(z.object({ sequence: z.number(), at: z.number(), kind: z.string() })),
});
export const statusSchema = z.object({
  at: z.number(),
  automation: z.enum(["off", "arming", "ready", "uncertain"]),
  mainAgentId: z.string().optional(),
  mainAgents: z.array(z.object({ agentId: z.string(), state: z.string() })).optional(),
  orchestrationVersion: z.number().optional(),
  writeAuthorization: z.object({ allowed: z.boolean(), reason: z.string() }).optional(),
  intake: z
    .object({
      intent: z.string(),
      origin: z.string(),
      source: z.string(),
      reason: z.string(),
      needExplorer: z.boolean(),
      needPlanner: z.boolean(),
      needAdvisor: z.boolean(),
      needImplementation: z.boolean(),
      extraReviewRecommended: z.boolean(),
    })
    .optional(),
  repositoryScope: z.object({ directory: z.string(), includesDescendants: z.boolean() }).optional(),
  dispatchPaused: z.boolean(),
  tasks: z.array(taskStatusSchema),
  historyLimited: z.boolean().optional(),
  runner: z.enum(["stopped", "starting", "running", "waiting", "failed"]),
  timelineAvailable: z.boolean().optional(),
});
export type WorkflowStatus = z.infer<typeof statusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const loadStatus = defineRpc({
  name: "orchestrator.status",
  input: z.object({ directory: z.string(), agentId: z.string().optional() }),
  output: statusSchema,
});
export const autoRouting = defineRpc({
  name: "orchestrator.auto-routing",
  input: z.object({ agentId: z.string(), enabled: z.boolean() }),
  output: statusSchema,
});
export const submitInput = defineRpc({
  name: "orchestrator.submit-input",
  input: z.object({
    agentId: z.string(),
    messageId: z.string().min(16),
    text: z.string().min(1).max(12000),
  }),
  output: z.object({ sent: z.boolean() }),
});
export const prepareInput = defineRpc({
  name: "orchestrator.prepare-input",
  input: z.object({
    agentId: z.string(),
    messageId: z.string().min(16),
    text: z.string().min(1).max(12000),
  }),
  output: z.union([
    z.object({ recorded: z.literal(true) }),
    z.object({ enabled: z.literal(false) }),
  ]),
});
export const abandonInput = defineRpc({
  name: "orchestrator.abandon-input",
  input: z.object({ agentId: z.string(), messageId: z.string().min(16) }),
  output: z.object({ abandoned: z.boolean() }),
});

export const phaseLabel: Record<string, string> = {
  READY: "Wartet auf Start",
  REWORK: "Nachbesserung",
  ACTIVE: "Agent arbeitet",
  SPAWN_INTENT: "Agentenstart vorbereitet",
  AGENT_BOUND: "Agent zugeordnet",
  AUTOMATIC_VERIFICATION: "Build, Tests und Diff geprüft",
  REVIEW_DONE: "Review liegt vor",
  REVIEW_NEEDS_CONFIRMATION: "Review-Abschluss muss bestätigt werden",
  VISUAL_ACCEPTANCE_REQUIRED: "Sichtprüfung durch dich erforderlich",
  REVIEW_RESULT_INVALID: "Review-Antwort hat nicht das vereinbarte Format",
  INTENT: "Start vorbereitet",
  SENDING: "Auftrag wird übergeben",
  RUNNING: "Agent arbeitet",
  TURN_COMPLETE: "Turn beendet – Abschlussprüfung",
  VERIFY: "Verifikation / Review",
  WAITING_PROCESSES: "Wartet auf Prozesse",
  NEEDS_CONFIRMATION: "Bestätigung erforderlich",
  PERMISSION: "Berechtigung erforderlich",
  UNKNOWN: "Ausgang unklar",
  BLOCKED: "Gesperrt",
  FAILED: "Fehlgeschlagen",
  COMPLETE: "Verifiziert abgeschlossen",
};
export const reasonLabel: Record<string, string> = {
  "transport-unknown":
    "Provider antwortet nicht; der Ausgang ist unklar. Bestehenden Worker vor einem Neustart prüfen.",
  "quota-5h": "Provider-Limit für das aktuelle Zeitfenster erreicht.",
  "quota-week":
    "Wöchentliches Provider-Limit gemeldet. Gilt für diesen Zugang, nicht für getrennte API-Routen.",
  "quota-month": "Monatliches Provider-Limit erreicht.",
  auth: "Anmeldung am Provider fehlgeschlagen.",
  "flex-unavailable": "Flex ist derzeit nicht verfügbar.",
  "model-missing": "Das konfigurierte Modell wurde beim Provider nicht gefunden.",
  "quality-data-budget-then-priority":
    "Die erste Route, die Qualität, Datenfreigabe und Budget erfüllt, wurde gemäß deiner Reihenfolge gewählt.",
  "same-task-role-model-and-context":
    "Passende bestehende Session wird für denselben Auftrag wiederverwendet.",
  "task-budget": "Lokales Taskbudget erreicht. Keine automatische Budgeterhöhung.",
  DECISIONS_QUALIFIED_CHOICE: "Historischer v2-Routingbefund; v3 verwendet feste Prioritäten.",
  DECISIONS_KEEP_DEFAULT: "Historischer v2-Routingbefund; v3 verwendet feste Prioritäten.",
  DECISIONS_SCOPE_BLOCKED: "Decisions ist für diesen Datenscope nicht freigegeben.",
  DECISIONS_NOT_ASSIGNED: "Für diese Rolle ist kein Decisions-Aufruf vorgesehen.",
  SINGLE_QUALIFIED_ROUTE: "Nur eine Route erfüllt die Freigaben.",
  DECISIONS_MONTHLY_CAP: "Decisions-Budget erreicht; neue Schreibfreigabe ausstehend.",
  DECISIONS_OUTCOME_UNKNOWN: "Decisions-Antwort unklar; kein neuer Writer freigegeben.",
  DECISIONS_INTAKE_OPTIONAL_FALLBACK:
    "Auftrag sicher erkannt; unklare Zusatzempfehlungen konservativ behandelt.",
  DECISIONS_PACKAGE_OPTIONAL_FALLBACK:
    "Aufgabenklasse sicher erkannt; zusätzliche Planung nach Paketvollständigkeit geprüft.",
  "data-scope-not-approved": "Datenschutzklasse nicht freigegeben",
  "repository-not-approved": "Repository nicht freigegeben",
  "quality-tier-insufficient": "Qualitätsstufe reicht nicht aus",
  "confirmed-provider-or-route-circuit": "Bestätigte Provider-/Routensperre",
  "api-budget-unavailable": "Keine freigegebene API-Reservierung verfügbar",
  "read-only-not-enforced": "Lesender Zugriff technisch nicht nachgewiesen",
  INTAKE_PENDING: "Eine neue Nachricht oder deren Übermittlung ist noch ungeklärt.",
  INTAKE_IMPLEMENTATION_NOT_AUTHORIZED: "Kein bestätigter Implementierungsauftrag freigegeben.",
  INTAKE_HUMAN_ORIGIN_UNCONFIRMED_USE_PLUGIN_INPUT:
    "Benutzerherkunft unbestätigt. Auftrag über den Plugin-Eingang absenden.",
  INTAKE_CLASSIFICATION_REQUIRED: "Noch kein klassifizierter Auftrag vorhanden.",
  AUTOMATION_NOT_READY: "Auto-Routing ist ausgeschaltet oder seine Aktivierung ungeklärt.",
  GLOBAL_DISPATCH_PAUSED: "Neue Starts sind global pausiert.",
  AUTHORIZED_INPUT:
    "Bestätigter Arbeitsauftrag liegt vor; Paket- und Qualitätsgates bleiben verbindlich.",
};

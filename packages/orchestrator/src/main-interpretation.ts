import {
  mainInputInterpretationSchema,
  mainPackageInterpretationSchema,
  type MainInputInterpretation,
  type MainPackageInterpretation,
} from "../paseo-plugin/shared/main-interpretation.ts";
import { hash } from "./contracts.ts";
import {
  fallbackPackage,
  packageFactsSchema,
  type Assessment,
  type IntakeResult,
  type PackageResult,
} from "./assessments.ts";
import type { Store } from "./store.ts";

const inputPrefix = "MAIN_INPUT_INTERPRETATION:";
const packagePrefix = "MAIN_PACKAGE_INTERPRETATION:";

export function mainInputInterpretation(
  store: Store,
  intakeId: string,
): MainInputInterpretation | undefined {
  const row = store.db
    .prepare(
      "SELECT kind FROM events WHERE kind LIKE 'MAIN_INPUT_INTERPRETATION:%' AND json_extract(substr(kind,?),'$.intakeId')=? ORDER BY sequence LIMIT 1",
    )
    .get(inputPrefix.length + 1, intakeId) as { kind: string } | undefined;
  return row
    ? mainInputInterpretationSchema.parse(JSON.parse(row.kind.slice(inputPrefix.length)))
    : undefined;
}
export function awaitsMainInterpretation(store: Store, intakeId: string): boolean {
  return !!store.db
    .prepare("SELECT 1 FROM events WHERE kind=?")
    .get(`MAIN_INPUT_AWAITING_INTERPRETATION:${intakeId}`);
}
export function mainInputResult(interpretation: MainInputInterpretation): IntakeResult {
  const action = interpretation.action;
  const implementation = ["start", "change", "approve"].includes(action);
  const intent = {
    plan: "new-task",
    review: "review-request",
    start: "new-task",
    question: "question",
    status: "status",
    continue: "approval",
    stop: "cancel",
    change: "change-request",
    approve: "approval",
  } as const;
  return {
    intent: intent[action],
    needImplementation: implementation,
    preserveExistingWork: ["question", "status", "continue"].includes(action),
    needExplorer: interpretation.needExplorer ?? false,
    needPlanner: action === "plan",
    needAdvisor: action === "review",
    extraReviewRecommended: false,
  };
}
export function mainIntakeAuthority(
  store: Store,
  assessment: Assessment<IntakeResult>,
): Assessment<IntakeResult> {
  const interpretation = mainInputInterpretation(store, assessment.id);
  if (!interpretation) return assessment;
  if (interpretation.factsHash !== assessment.factsHash) throw Error("MAIN_INPUT_FACTS_CHANGED");
  return {
    id: assessment.id,
    kind: "intake",
    factsHash: interpretation.factsHash,
    version: "main-input-v1",
    source: "main",
    reason: "MAIN_INPUT_INTERPRETED",
    result: mainInputResult(interpretation),
  };
}
export function readIntakeAssessment(store: Store, intakeId: string): Assessment<IntakeResult> {
  const row = store.db
    .prepare("SELECT facts_hash,result_json FROM assessments WHERE id=? AND kind='intake'")
    .get(intakeId) as { facts_hash: string; result_json: string | null } | undefined;
  if (!row) throw Error("INTAKE_CLASSIFICATION_REQUIRED");
  return row.result_json
    ? JSON.parse(row.result_json)
    : {
        id: intakeId,
        kind: "intake",
        factsHash: row.facts_hash,
        version: "intake-v3",
        source: "fallback",
        reason: "ADVICE_PENDING",
        result: {
          intent: "other",
          needImplementation: false,
          needExplorer: false,
          needPlanner: false,
          needAdvisor: false,
          extraReviewRecommended: false,
        },
      };
}
export function readPackageAssessment(store: Store, packageId: string): Assessment<PackageResult> {
  const row = store.db
    .prepare("SELECT facts_hash,result_json FROM assessments WHERE id=? AND kind='package'")
    .get(packageId) as { facts_hash: string; result_json: string | null } | undefined;
  if (!row) throw Error("TASK_ASSESSMENT_REQUIRED");
  const raw: Assessment<PackageResult> = row.result_json
    ? JSON.parse(row.result_json)
    : {
        id: packageId,
        kind: "package",
        factsHash: row.facts_hash,
        version: "package-v3",
        source: "fallback",
        reason: "ADVICE_PENDING",
        result: fallbackPackage(),
      };
  return effectivePackageAssessment(store, raw);
}
export function persistMainInputInterpretation(
  store: Store,
  interpretation: MainInputInterpretation,
): void {
  store.event(`${inputPrefix}${JSON.stringify(interpretation)}`);
}
export function effectivePackageAssessment(
  store: Store,
  assessment: Assessment<PackageResult>,
): Assessment<PackageResult> {
  const rows = store.db
    .prepare(
      "SELECT kind FROM events WHERE kind LIKE 'MAIN_PACKAGE_INTERPRETATION:%' ORDER BY sequence",
    )
    .all() as { kind: string }[];
  const interpretation = rows
    .map((row) =>
      mainPackageInterpretationSchema.parse(JSON.parse(row.kind.slice(packagePrefix.length))),
    )
    .find((value) => value.packageAssessmentId === assessment.id);
  if (!interpretation) return assessment;
  if (interpretation.factsHash !== assessment.factsHash) throw Error("MAIN_PACKAGE_FACTS_CHANGED");
  return {
    id: assessment.id,
    kind: "package",
    factsHash: interpretation.factsHash,
    version: "main-package-v1",
    source: "main",
    reason: "MAIN_PACKAGE_INTERPRETED",
    result: {
      ...interpretation.declaration,
      shouldSplit: false,
      extraReviewRecommended: false,
    },
  };
}
export function declareMainPackage(store: Store, interpretation: MainPackageInterpretation): void {
  interpretation = mainPackageInterpretationSchema.parse(interpretation);
  const old = store.db
    .prepare("SELECT kind FROM events WHERE kind LIKE 'MAIN_PACKAGE_INTERPRETATION:%'")
    .all() as { kind: string }[];
  const previous = old
    .map((row) =>
      mainPackageInterpretationSchema.parse(JSON.parse(row.kind.slice(packagePrefix.length))),
    )
    .find((value) => value.packageAssessmentId === interpretation.packageAssessmentId);
  if (previous) {
    if (hash(previous) !== hash(interpretation))
      throw Error("MAIN_PACKAGE_INTERPRETATION_CONFLICT");
    return;
  }
  if (
    store.db
      .prepare("SELECT 1 FROM task_assessments WHERE package_id=?")
      .get(interpretation.packageAssessmentId)
  )
    throw Error("MAIN_PACKAGE_ALREADY_REGISTERED");
  const row = store.db
    .prepare("SELECT facts_hash,facts_json FROM assessments WHERE id=? AND kind='package'")
    .get(interpretation.packageAssessmentId) as
    | { facts_hash: string; facts_json: string }
    | undefined;
  if (!row || row.facts_hash !== interpretation.factsHash)
    throw Error("MAIN_PACKAGE_FACTS_CHANGED");
  const facts = packageFactsSchema.parse(JSON.parse(row.facts_json));
  const selected = interpretation.declaration.workKind;
  if (
    selected &&
    !["ui", "general"].includes(selected) &&
    !facts.workCategoryCatalog?.some((category) => category.id === selected)
  )
    throw Error("MAIN_PACKAGE_CATEGORY_UNKNOWN");
  store.event(`${packagePrefix}${JSON.stringify(interpretation)}`);
}

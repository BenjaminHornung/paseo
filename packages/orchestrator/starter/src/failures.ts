import type { ProviderFailure } from "./types.ts";
export function classifyFailure(params: {
  httpStatus?: number;
  providerCode?: string;
  resultStatus?: string;
  message?: string;
}): ProviderFailure {
  const { providerCode = "", resultStatus = "", message = "" } = params;
  const parsedStatus = message.match(/\b(?:http|status)\s*[:=]?\s*(\d{3})/i);
  const httpStatus = params.httpStatus ?? (parsedStatus ? Number(parsedStatus[1]) : undefined);
  const txt = `${providerCode} ${message}`.toLowerCase();
  if (txt.includes("orchestrator task budget exhausted")) return "task-budget";
  if (resultStatus === "permission" || (httpStatus === 403 && txt.includes("permission")))
    return "permission";
  if (/resource.?unavailable|flex.?unavailable/.test(txt)) return "flex-unavailable";
  if (resultStatus === "timeout" || txt.includes("unknown outcome")) return "transport-unknown";
  if (httpStatus === 401 || txt.includes("invalid_api_key")) return "auth";
  if (httpStatus === 404 || txt.includes("model_not_found")) return "model-missing";
  if (txt.includes("weekly") || txt.includes("week_limit")) return "quota-week";
  if (
    txt.includes("monthly") ||
    txt.includes("credit_balance_exhausted") ||
    txt.includes("quota_exhausted") ||
    txt.includes("insufficient_quota") ||
    txt.includes("spend_limit")
  )
    return "quota-month";
  if (txt.includes("5.hour") || txt.includes("5h_limit")) return "quota-5h";
  if (httpStatus === 429 || /rate.?limit|http\s*429/.test(txt)) return "rate-limited";
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) return "transient";
  if (txt.includes("connection lost") || txt.includes("econnreset")) return "transport-unknown";
  if (resultStatus === "error") return "quality";
  return "invalid-data";
}
export function nextAction(
  kind: ProviderFailure,
): "wait-reset" | "short-retry" | "reconcile" | "disable" | "ask-human" | "rework" {
  switch (kind) {
    case "quota-5h":
    case "quota-week":
    case "quota-month":
    case "rate-limited":
      return "wait-reset";
    case "transient":
    case "flex-unavailable":
      return "short-retry";
    case "transport-unknown":
      return "reconcile";
    case "auth":
    case "model-missing":
      return "disable";
    case "permission":
    case "invalid-data":
    case "task-budget":
      return "ask-human";
    case "quality":
      return "rework";
  }
}

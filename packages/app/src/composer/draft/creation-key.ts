/**
 * The creation key for a draft's request. The daemon keeps one request per key, so retrying the
 * same draft resumes its creation, while an edited draft is a new request with its own key.
 */
export function draftCreationKey(draftId: string, request: object): string {
  return `${draftId}:${hash(canonicalJson(neutralizeHarnessAgentIds(request)))}`;
}

export type CreationAgentIdNamespace = "workspace-draft" | "new-workspace-initial";

export function draftCreationAgentId(
  draftId: string,
  request: object,
  namespace: CreationAgentIdNamespace,
): string {
  const requestJson = canonicalJson(neutralizeHarnessAgentIds(request));
  const material = `${namespace}\0${draftId}\0${requestJson}`;
  const hashRuns = [0, 1, 2].map((run) =>
    Number.parseInt(hash(`paseo-agent-id-v1\0${namespace}\0${run}\0${material}`), 36)
      .toString(16)
      .padStart(14, "0"),
  );
  const rawHex = hashRuns.join("").slice(0, 32);
  const versionedHex = `${rawHex.slice(0, 12)}8${rawHex.slice(13)}`;
  const variantNibble = ((Number.parseInt(versionedHex[16], 16) & 0x3) | 0x8).toString(16);
  const uuidHex = `${versionedHex.slice(0, 16)}${variantNibble}${versionedHex.slice(17)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
}

function neutralizeHarnessAgentIds(request: object): object {
  if (!isRecord(request) || !Array.isArray(request.attachments)) return request;
  const hasHarnessContext = request.attachments.some((attachment) => {
    if (!isRecord(attachment) || attachment.type !== "text") return false;
    const context = attachment.harnessContext;
    return isRecord(context) && typeof context.agentId === "string";
  });
  if (!hasHarnessContext) return request;

  const attachments = request.attachments.map((attachment) => {
    if (!isRecord(attachment) || attachment.type !== "text") return attachment;
    const context = attachment.harnessContext;
    if (!isRecord(context) || typeof context.agentId !== "string") return attachment;
    return { ...attachment, harnessContext: { ...context, agentId: "__harness_agent_id__" } };
  });

  return {
    ...request,
    ...(typeof request.agentId === "string" ? { agentId: "__harness_agent_id__" } : {}),
    attachments,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

// 53-bit cyrb53: distinguishes the edits of one draft without WebCrypto, which needs HTTPS.
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

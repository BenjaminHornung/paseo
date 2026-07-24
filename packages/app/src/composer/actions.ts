import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
} from "@/attachments/types";
import type { WorkspaceAttachmentRemovalResult } from "@/composer/attachments/workspace";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import {
  appendOptimisticUserMessageToStream,
  buildOptimisticUserMessage,
  generateMessageId,
  type StreamItem,
  type UserMessageItem,
} from "@/types/stream";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { i18n } from "@/i18n/i18next";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

export interface AttachmentPersister {
  persistFromBlob: (input: {
    blob: Blob;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromFileUri: (input: {
    uri: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  deleteAttachments: (metadata: AttachmentMetadata[]) => Promise<void> | void;
}

export interface ComposerSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      images: Array<{ data: string; mimeType: string }>;
      attachments: ReturnType<typeof splitComposerAttachmentsForSubmit>["attachments"];
    },
  ) => Promise<void>;
  uploadFile: (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => Promise<{
    requestId: string;
    file: {
      type: "uploaded_file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
    } | null;
    error: string | null;
  }>;
}

export interface ComposerCancelClient {
  cancelAgent: (agentId: string) => Promise<void> | void;
}

export interface AgentStreamWriter {
  getTail: (agentId: string) => StreamItem[] | undefined;
  getHead: (agentId: string) => StreamItem[] | undefined;
  setHead: (updater: (prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>) => void;
  setTail: (updater: (prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>) => void;
}

export interface QueueWriter {
  read: (agentId: string) => QueuedComposerMessage[];
  write: (
    updater: (prev: Map<string, QueuedComposerMessage[]>) => Map<string, QueuedComposerMessage[]>,
  ) => void;
}

export interface QueuedComposerActionController {
  isPending(messageId: string): boolean;
  tryAcquire(messageId: string): boolean;
  release(messageId: string): void;
}

export function createQueuedComposerActionController(input: {
  onChange: (pending: ReadonlySet<string>) => void;
}): QueuedComposerActionController {
  const locked = new Set<string>();
  const publish = () => input.onChange(new Set(locked));
  return {
    isPending: (messageId) => locked.has(messageId),
    tryAcquire(messageId) {
      if (locked.has(messageId)) {
        return false;
      }
      locked.add(messageId);
      publish();
      return true;
    },
    release(messageId) {
      if (!locked.delete(messageId)) {
        return;
      }
      publish();
    },
  };
}

export async function runQueuedComposerControlledAction<T>(input: {
  messageId: string;
  controller: QueuedComposerActionController;
  run: () => Promise<T>;
}): Promise<{ status: "blocked" } | { status: "completed"; result: T }> {
  if (!input.controller.tryAcquire(input.messageId)) {
    return { status: "blocked" };
  }
  try {
    return { status: "completed", result: await input.run() };
  } finally {
    input.controller.release(input.messageId);
  }
}

export async function pickAndPersistImages(input: {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  persister: Pick<AttachmentPersister, "persistFromBlob" | "persistFromFileUri">;
}): Promise<AttachmentMetadata[]> {
  const result = await input.pickImages();
  if (!result?.length) return [];
  return await Promise.all(
    result.map(async (picked) => {
      const fileName = picked.fileName ?? null;
      const mimeType = picked.mimeType || "image/jpeg";
      if (picked.source.kind === "blob") {
        return await input.persister.persistFromBlob({
          blob: picked.source.blob,
          mimeType,
          fileName,
        });
      }
      return await input.persister.persistFromFileUri({
        uri: picked.source.uri,
        mimeType,
        fileName,
      });
    }),
  );
}

export async function uploadFileAttachments(input: {
  client: ComposerSendClient;
  files: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }>;
}): Promise<Extract<ComposerAttachment, { kind: "file" }>[]> {
  const result: Extract<ComposerAttachment, { kind: "file" }>[] = [];

  for (const file of input.files) {
    const response = await input.client.uploadFile(file);
    if (response.error || !response.file) {
      throw new Error(response.error ?? "Upload failed.");
    }
    result.push({ kind: "file", attachment: response.file });
  }

  return result;
}

export function removeComposerAttachmentAtIndex<T extends ComposerAttachment>(input: {
  attachments: T[];
  index: number;
  deleteAttachments: AttachmentPersister["deleteAttachments"];
}): T[] {
  const removed = input.attachments[input.index];
  if (removed?.kind === "image") {
    void input.deleteAttachments([removed.metadata]);
  }
  return input.attachments.filter((_, i) => i !== input.index);
}

export function isSameComposerAttachment(
  left: ComposerAttachment | undefined,
  right: ComposerAttachment | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "image":
      return (
        right.kind === "image" &&
        left.metadata.id === right.metadata.id &&
        left.metadata.storageKey === right.metadata.storageKey
      );
    case "file":
      return (
        right.kind === "file" &&
        left.attachment.id === right.attachment.id &&
        left.attachment.path === right.attachment.path
      );
    case "agent_attachment":
      return right.kind === "agent_attachment" && equal(left.attachment, right.attachment);
    case "forge_issue":
    case "forge_change_request":
    case "github_issue":
    case "github_pr":
      return "item" in right && equal(left.item, right.item);
    default:
      return equal(left, right);
  }
}

export function removeComposerNormalAttachmentIfCurrent(input: {
  currentAttachments: readonly ComposerAttachment[];
  expectedAttachment: UserComposerAttachment | undefined;
  index: number;
  deleteAttachments: AttachmentPersister["deleteAttachments"];
}): {
  status: "removed" | "noop";
  nextAttachments: ComposerAttachment[];
  nextUserAttachments: UserComposerAttachment[];
} {
  const current = input.currentAttachments[input.index];
  if (
    !input.expectedAttachment ||
    !current ||
    !isSameComposerAttachment(current, input.expectedAttachment)
  ) {
    return {
      status: "noop",
      nextAttachments: [...input.currentAttachments],
      nextUserAttachments: userAttachmentsOnly(input.currentAttachments),
    };
  }
  const nextAttachments = removeComposerAttachmentAtIndex({
    attachments: [...input.currentAttachments],
    index: input.index,
    deleteAttachments: input.deleteAttachments,
  });
  return {
    status: "removed",
    nextAttachments,
    nextUserAttachments: userAttachmentsOnly(nextAttachments),
  };
}

export interface CancelComposerAgentInput {
  client: ComposerCancelClient | null;
  agentId: string;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
  onCancelFailed: (error: unknown) => void;
}

export function cancelComposerAgent(input: CancelComposerAgentInput): boolean {
  if (!input.isAgentRunning || input.isCancellingAgent) return false;
  if (!input.isConnected || !input.client) return false;
  try {
    void Promise.resolve(input.client.cancelAgent(input.agentId)).catch(input.onCancelFailed);
  } catch (error) {
    input.onCancelFailed(error);
    return false;
  }
  return true;
}

export interface DispatchComposerAgentMessageInput {
  client: ComposerSendClient;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  stream: AgentStreamWriter;
}

export async function dispatchComposerAgentMessage(
  input: DispatchComposerAgentMessageInput,
): Promise<void> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.attachmentSubmitFormat,
  });
  const messageId = generateMessageId();
  const userMessage = buildOptimisticUserMessage({
    id: messageId,
    text: input.text,
    timestamp: new Date(),
    images: wirePayload.images,
    attachments: wirePayload.attachments,
  });
  appendUserMessageToStream(input.agentId, userMessage, input.stream);
  const imagesData = await input.encodeImages(wirePayload.images);
  await input.client.sendAgentMessage(input.agentId, input.text, {
    messageId,
    images: imagesData ?? [],
    attachments: wirePayload.attachments,
  });
}

function appendUserMessageToStream(
  agentId: string,
  userMessage: UserMessageItem,
  stream: AgentStreamWriter,
): void {
  const result = appendOptimisticUserMessageToStream({
    tail: stream.getTail(agentId) ?? [],
    head: stream.getHead(agentId) ?? [],
    message: userMessage,
    placement: "active-head",
  });
  if (result.changedHead) {
    stream.setHead((prev) => {
      const next = new Map(prev);
      next.set(agentId, result.head);
      return next;
    });
  }
  if (result.changedTail) {
    stream.setTail((prev) => {
      const next = new Map(prev);
      next.set(agentId, result.tail);
      return next;
    });
  }
}

export interface QueueComposerMessageInput {
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  queue: QueueWriter;
  messageId?: string;
}

export interface QueueComposerMessageResult {
  queued: QueuedComposerMessage | null;
}

export interface QueueComposerServerMessageInput {
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  queue: QueueWriter;
  messageId?: string;
  registerIntent: (message: QueuedComposerMessage) => void;
  send: (message: QueuedComposerMessage) => Promise<void>;
}

export function queueComposerMessage(input: QueueComposerMessageInput): QueueComposerMessageResult {
  const trimmed = input.text.trim();
  if (!trimmed && input.attachments.length === 0) {
    return { queued: null };
  }
  const item: QueuedComposerMessage = {
    id: input.messageId ?? generateMessageId(),
    text: trimmed,
    attachments: input.attachments,
  };
  input.queue.write((prev) => {
    const next = new Map(prev);
    const current = prev.get(input.agentId) ?? [];
    const existingIndex = current.findIndex((queued) => queued.id === item.id);
    if (existingIndex >= 0) {
      const replacement = [...current];
      replacement.splice(existingIndex, 1, item);
      next.set(input.agentId, replacement);
    } else {
      next.set(input.agentId, [...current, item]);
    }
    return next;
  });
  return { queued: item };
}

export function queueComposerServerMessage(
  input: QueueComposerServerMessageInput,
): QueueComposerMessageResult & { submit?: () => Promise<void> } {
  const result = queueComposerMessage(input);
  if (!result.queued) {
    return result;
  }
  input.registerIntent(result.queued);
  return {
    ...result,
    submit: async () => await input.send(result.queued as QueuedComposerMessage),
  };
}

export interface EditQueuedComposerMessageInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
}

export interface EditQueuedComposerMessageResult {
  text: string;
  attachments: UserComposerAttachment[];
}

export function getQueuedComposerMessageEditDraft(input: {
  messages: readonly QueuedComposerMessage[];
  messageId: string;
}): EditQueuedComposerMessageResult | null {
  const item = input.messages.find((q) => q.id === input.messageId);
  if (!item) return null;
  return {
    text: item.text,
    attachments: buildRecoverableQueuedComposerDraftAttachments(item.attachments),
  };
}

export function editQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): EditQueuedComposerMessageResult | null {
  const result = getQueuedComposerMessageEditDraft({
    messages: input.queue.read(input.agentId),
    messageId: input.messageId,
  });
  if (!result) return null;
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  return result;
}

export interface SendQueuedComposerMessageNowInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  submitMessage: (input: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
  failedToSendMessage?: string;
}

export type SendQueuedComposerMessageNowResult =
  | { status: "missing" }
  | { status: "submitted" }
  | { status: "failed"; errorMessage: string };

export interface RemoveQueuedComposerMessageInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  cancelMessage?: (input: { agentId: string; messageId: string }) => Promise<void>;
  requireRemoteCancel?: boolean;
  failedToRemoveMessage?: string;
}

export type RemoveQueuedComposerMessageResult =
  | { status: "missing" }
  | { status: "removed" }
  | { status: "failed"; errorMessage: string };

export function buildRecoverableQueuedComposerDraftAttachments(
  attachments: readonly ComposerAttachment[],
): UserComposerAttachment[] {
  const recovered: UserComposerAttachment[] = [];

  for (const attachment of attachments) {
    if (
      attachment.kind === "image" ||
      attachment.kind === "file" ||
      attachment.kind === "agent_attachment" ||
      attachment.kind === "forge_issue" ||
      attachment.kind === "forge_change_request" ||
      attachment.kind === "github_issue" ||
      attachment.kind === "github_pr"
    ) {
      recovered.push(attachment);
      continue;
    }

    const wirePayload = splitComposerAttachmentsForSubmit([attachment]);
    for (const image of wirePayload.images) {
      recovered.push({ kind: "image", metadata: image });
    }
    for (const agentAttachment of wirePayload.attachments) {
      recovered.push({ kind: "agent_attachment", attachment: agentAttachment });
    }
  }

  return recovered;
}

export function applyQueuedComposerEditDraftIfUnchanged(input: {
  startedGeneration: number;
  getCurrentGeneration: () => number;
  draft: EditQueuedComposerMessageResult;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: UserComposerAttachment[]) => void;
}): boolean {
  if (input.getCurrentGeneration() !== input.startedGeneration) {
    return false;
  }
  input.setUserInput(input.draft.text);
  input.setAttachments(input.draft.attachments);
  return true;
}

export function preserveQueuedComposerMessage(input: {
  agentId: string;
  queue: QueueWriter;
  message: QueuedComposerMessage;
}): void {
  queueComposerMessage({
    agentId: input.agentId,
    text: input.message.text,
    attachments: input.message.attachments,
    queue: input.queue,
    messageId: input.message.id,
  });
}

export function recoverQueuedComposerEditCancellation(input: {
  agentId: string;
  queue: QueueWriter;
  message: QueuedComposerMessage;
  startedGeneration: number;
  getCurrentGeneration: () => number;
  draft: EditQueuedComposerMessageResult;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: UserComposerAttachment[]) => void;
  registerRecoverableIntent: (message: QueuedComposerMessage) => void;
}): "restored" | "requeued" {
  const restored = applyQueuedComposerEditDraftIfUnchanged({
    startedGeneration: input.startedGeneration,
    getCurrentGeneration: input.getCurrentGeneration,
    draft: input.draft,
    setUserInput: input.setUserInput,
    setAttachments: input.setAttachments,
  });
  if (restored) {
    return "restored";
  }
  input.registerRecoverableIntent(input.message);
  preserveQueuedComposerMessage({
    agentId: input.agentId,
    queue: input.queue,
    message: input.message,
  });
  return "requeued";
}

export function removeComposerAttachmentWithWorkspaceSupport(input: {
  selectedAttachments: readonly ComposerAttachment[];
  index: number;
  markGithubAttachmentRemoved: (attachment: ComposerAttachment | undefined) => void;
  removeWorkspaceAttachment: (input: {
    selectedAttachments: readonly ComposerAttachment[];
    index: number;
  }) => WorkspaceAttachmentRemovalResult;
  removeNormalAttachment: () => "removed" | "noop";
  bumpGeneration: () => void;
}): "removed-workspace" | "removed-user" | "noop" {
  const selected = input.selectedAttachments[input.index];
  if (!selected) {
    return "noop";
  }
  input.markGithubAttachmentRemoved(selected);
  const workspaceRemoval = input.removeWorkspaceAttachment({
    selectedAttachments: input.selectedAttachments,
    index: input.index,
  });
  if (workspaceRemoval === "removed") {
    input.bumpGeneration();
    return "removed-workspace";
  }
  if (workspaceRemoval === "noop") {
    return "noop";
  }
  const normalRemoval = input.removeNormalAttachment();
  if (normalRemoval === "noop") {
    return "noop";
  }
  input.bumpGeneration();
  return "removed-user";
}

export function clearOwnedQueuedComposerMirror(input: {
  agentId: string;
  queue: QueueWriter;
  message: QueuedComposerMessage;
}): boolean {
  let removed = false;
  input.queue.write((prev) => {
    const current = prev.get(input.agentId) ?? [];
    const nextMessages: QueuedComposerMessage[] = [];
    let didRemove = false;
    for (const queued of current) {
      if (!didRemove && queued.id === input.message.id && equal(queued, input.message)) {
        didRemove = true;
        removed = true;
        continue;
      }
      nextMessages.push(queued);
    }
    if (!didRemove) {
      return prev;
    }
    const next = new Map(prev);
    next.set(input.agentId, nextMessages);
    return next;
  });
  return removed;
}

export async function orchestrateQueuedComposerServerEditCancellation(input: {
  agentId: string;
  messageId: string;
  message: QueuedComposerMessage;
  queue: QueueWriter;
  startedGeneration: number;
  getCurrentGeneration: () => number;
  draft: EditQueuedComposerMessageResult;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: UserComposerAttachment[]) => void;
  registerIntent: (message: QueuedComposerMessage) => object | null;
  clearIntentIfCurrent: (messageId: string, token: object | null) => boolean;
  enqueueCompensation: (messageId: string) => void;
  cancelMessage: (agentId: string, messageId: string) => Promise<void>;
  onError: (error: unknown) => void;
}): Promise<"restored" | "requeued" | "failed"> {
  const ownershipToken = input.registerIntent(input.message);
  try {
    await input.cancelMessage(input.agentId, input.messageId);
    const recovery = recoverQueuedComposerEditCancellation({
      agentId: input.agentId,
      queue: input.queue,
      message: input.message,
      startedGeneration: input.startedGeneration,
      getCurrentGeneration: input.getCurrentGeneration,
      draft: input.draft,
      setUserInput: input.setUserInput,
      setAttachments: input.setAttachments,
      registerRecoverableIntent: input.registerIntent,
    });
    if (recovery === "restored") {
      const cleared = input.clearIntentIfCurrent(input.messageId, ownershipToken);
      if (cleared) {
        clearOwnedQueuedComposerMirror({
          agentId: input.agentId,
          queue: input.queue,
          message: input.message,
        });
      }
      return "restored";
    }
    input.enqueueCompensation(input.messageId);
    return "requeued";
  } catch (error) {
    input.enqueueCompensation(input.messageId);
    input.onError(error);
    return "failed";
  }
}

export async function removeQueuedComposerMessage(
  input: RemoveQueuedComposerMessageInput,
): Promise<RemoveQueuedComposerMessageResult> {
  const item = input.queue.read(input.agentId).find((message) => message.id === input.messageId);
  if (!item) {
    return { status: "missing" };
  }

  if (input.cancelMessage) {
    try {
      await input.cancelMessage({
        agentId: input.agentId,
        messageId: input.messageId,
      });
      return { status: "removed" };
    } catch (error) {
      return {
        status: "failed",
        errorMessage:
          error instanceof Error
            ? error.message
            : (input.failedToRemoveMessage ?? i18n.t("common.actions.remove")),
      };
    }
  }

  if (input.requireRemoteCancel) {
    return {
      status: "failed",
      errorMessage: input.failedToRemoveMessage ?? i18n.t("common.actions.remove"),
    };
  }

  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((message) => message.id !== input.messageId),
    );
    return next;
  });
  return { status: "removed" };
}

export async function sendQueuedComposerMessageNow(
  input: SendQueuedComposerMessageNowInput,
): Promise<SendQueuedComposerMessageNowResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  try {
    await input.submitMessage({ text: item.text, attachments: item.attachments });
    return { status: "submitted" };
  } catch (error) {
    input.queue.write((prev) => {
      const next = new Map(prev);
      next.set(input.agentId, [item, ...(prev.get(input.agentId) ?? [])]);
      return next;
    });
    return {
      status: "failed",
      errorMessage:
        error instanceof Error
          ? error.message
          : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    };
  }
}

export interface OpenComposerAttachmentInput {
  attachment: ComposerAttachment;
  setLightboxMetadata: (metadata: AttachmentMetadata) => void;
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean;
  openExternalUrl: (url: string) => void;
}

export function openComposerAttachment(input: OpenComposerAttachmentInput): void {
  if (input.attachment.kind === "image") {
    input.setLightboxMetadata(input.attachment.metadata);
    return;
  }
  if (input.attachment.kind === "file") {
    return;
  }
  if (input.attachment.kind === "agent_attachment") {
    const attachment = input.attachment.attachment;
    if ((attachment.type === "github_pr" || attachment.type === "github_issue") && attachment.url) {
      input.openExternalUrl(attachment.url);
    }
    return;
  }
  if (isWorkspaceAttachment(input.attachment)) {
    input.openWorkspaceAttachment({ attachment: input.attachment });
    return;
  }
  input.openExternalUrl(input.attachment.item.url);
}

export function buildForgeAttachment(item: ForgeSearchItem): UserComposerAttachment {
  return item.kind === "change_request"
    ? { kind: "forge_change_request", item }
    : { kind: "forge_issue", item };
}

function isForgeAttachment(
  attachment: UserComposerAttachment,
): attachment is Extract<
  UserComposerAttachment,
  { kind: "forge_issue" | "forge_change_request" | "github_issue" | "github_pr" }
> {
  return (
    attachment.kind === "forge_issue" ||
    attachment.kind === "forge_change_request" ||
    // COMPAT(githubAttachmentKinds): added in v0.1.106, remove after 2026-12-28 once daemon floor >= v0.1.106
    attachment.kind === "github_issue" ||
    attachment.kind === "github_pr"
  );
}

export function toggleForgeAttachment(
  current: UserComposerAttachment[],
  item: ForgeSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    isForgeAttachment(attachment) &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildForgeAttachment(item)];
}

interface ToggleGithubAttachmentFromPickerInput {
  current: UserComposerAttachment[];
  item: ForgeSearchItem;
  markGithubAttachmentRemoved: (attachment: UserComposerAttachment) => void;
}

export function toggleGithubAttachmentFromPicker({
  current,
  item,
  markGithubAttachmentRemoved,
}: ToggleGithubAttachmentFromPickerInput): UserComposerAttachment[] {
  const existingAttachment = current.find(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
  if (existingAttachment) {
    markGithubAttachmentRemoved(existingAttachment);
  }
  return toggleForgeAttachment(current, item);
}

export function findGithubItemByOption(
  items: readonly ForgeSearchItem[],
  optionId: string,
): ForgeSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

export function isAttachmentSelectedForGithubItem(
  current: readonly ComposerAttachment[],
  item: ForgeSearchItem,
): boolean {
  return userAttachmentsOnly(current).some(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
}

export const toggleGithubAttachment = toggleForgeAttachment;

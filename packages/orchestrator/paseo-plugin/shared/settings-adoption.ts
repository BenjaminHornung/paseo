/** Minimal view shape the adoption decision needs. */
export interface RevisionView {
  revision: string;
  credentials: { normal: { revision: string }; decisions: { revision: string } };
}

/**
 * Decides whether a (re)loaded server view replaces the one the screen shows.
 * A cached view from before an unmount flush can be older than the server; adopt the
 * server view whenever nothing local would be lost (no unsaved edit, no save in flight).
 */
export function shouldAdoptServerView(input: {
  current: RevisionView | undefined;
  server: RevisionView | undefined;
  dirty: boolean;
  saving: boolean;
}): boolean {
  const { current, server } = input;
  if (!server || input.dirty || input.saving) return false;
  if (!current) return true;
  return (
    current.revision !== server.revision ||
    current.credentials.normal.revision !== server.credentials.normal.revision ||
    current.credentials.decisions.revision !== server.credentials.decisions.revision
  );
}

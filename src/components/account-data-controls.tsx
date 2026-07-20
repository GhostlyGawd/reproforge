"use client";

import {
  CheckCircle2,
  Download,
  LoaderCircle,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { ACCOUNT_DELETION_CONFIRMATION } from "@/application/account-data-contracts";

type ActionState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function errorMessage(code: unknown, action: "delete" | "export"): string {
  if (code === "EXPORT_QUOTA_EXCEEDED") {
    return "The daily account export limit has been reached.";
  }
  if (code === "INVALID_ACCOUNT_DATA_REQUEST") {
    return "The confirmation did not match. No data was changed.";
  }
  return action === "export"
    ? "The export is temporarily unavailable. Try again without changing your account."
    : "The deletion request was not accepted. Your account remains unchanged.";
}

export function AccountDataControls({ enabled = true }: { enabled?: boolean }) {
  const [confirmation, setConfirmation] = useState("");
  const [exportState, setExportState] = useState<ActionState>({ kind: "idle" });
  const [deleteState, setDeleteState] = useState<ActionState>({ kind: "idle" });

  async function downloadExport() {
    if (!enabled) return;
    setExportState({ kind: "working" });
    try {
      const response = await fetch("/api/account/export", {
        cache: "no-store",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { code?: unknown } }
          | null;
        setExportState({
          kind: "error",
          message: errorMessage(body?.error?.code, "export"),
        });
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename =
        disposition.match(/filename="([A-Za-z0-9.-]+)"/)?.[1] ??
        "reproforge-account-export.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      const manifest = response.headers.get("X-ReproForge-Manifest-SHA256");
      setExportState({
        kind: "success",
        message: manifest
          ? `Export ready. Manifest SHA-256 ${manifest}`
          : "Export ready and downloaded.",
      });
    } catch {
      setExportState({
        kind: "error",
        message: errorMessage(null, "export"),
      });
    }
  }

  async function requestDeletion() {
    if (!enabled || confirmation !== ACCOUNT_DELETION_CONFIRMATION) return;
    setDeleteState({ kind: "working" });
    try {
      const response = await fetch("/api/account/delete", {
        body: JSON.stringify({ confirmation }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | {
            data?: { requestId?: string };
            error?: { code?: unknown };
          }
        | null;
      if (!response.ok) {
        setDeleteState({
          kind: "error",
          message: errorMessage(body?.error?.code, "delete"),
        });
        return;
      }
      setConfirmation("");
      setDeleteState({
        kind: "success",
        message: body?.data?.requestId
          ? `Deletion scheduled. Receipt ${body.data.requestId}. New work is now suspended.`
          : "Deletion scheduled. New work is now suspended.",
      });
    } catch {
      setDeleteState({
        kind: "error",
        message: errorMessage(null, "delete"),
      });
    }
  }

  return (
    <section
      className="data-control-stack"
      aria-label="Account data actions"
      data-controls-enabled={enabled}
    >
      <article className="data-control-card" data-disabled={!enabled}>
        <div className="data-control-icon" aria-hidden="true">
          <Download size={19} />
        </div>
        <div className="data-control-copy">
          <p className="account-label">Portable archive</p>
          <h2>Export before you erase.</h2>
          <p>
            Download one integrity-checked JSON archive containing your durable
            cases, evidence, manifests, and private artifact bytes. Active work
            must finish or be cancelled before an export can be sealed.
          </p>
          <button
            className="secondary-button data-control-button"
            disabled={!enabled || exportState.kind === "working"}
            onClick={downloadExport}
            type="button"
          >
            {exportState.kind === "working" ? (
              <LoaderCircle className="button-spinner" size={17} aria-hidden="true" />
            ) : (
              <Download size={17} aria-hidden="true" />
            )}
            {exportState.kind === "working" ? "Preparing export…" : "Download account export"}
          </button>
          {exportState.kind === "success" || exportState.kind === "error" ? (
            <p
              className={`data-control-status is-${exportState.kind}`}
              role={exportState.kind === "error" ? "alert" : "status"}
            >
              {exportState.kind === "success" ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <ShieldAlert size={15} aria-hidden="true" />
              )}
              <span>{exportState.message}</span>
            </p>
          ) : null}
        </div>
      </article>

      <article className="data-control-card is-danger" data-disabled={!enabled}>
        <div className="data-control-icon" aria-hidden="true">
          <Trash2 size={19} />
        </div>
        <div className="data-control-copy">
          <p className="account-label">Destructive control</p>
          <h2>Delete this ReproForge account.</h2>
          <p id="deletion-explanation">
            This immediately suspends new starts, requests cancellation of
            active work, deletes private objects before database rows, and keeps
            only a sanitized deletion tombstone for 365 days. It cannot be undone.
          </p>
          <label className="confirmation-field">
            <span>Type {ACCOUNT_DELETION_CONFIRMATION} to confirm</span>
            <input
              aria-describedby="deletion-explanation"
              autoComplete="off"
              disabled={!enabled}
              onChange={(event) => setConfirmation(event.target.value)}
              spellCheck={false}
              value={confirmation}
            />
          </label>
          <button
            className="danger-button data-control-button"
            disabled={
              !enabled ||
              confirmation !== ACCOUNT_DELETION_CONFIRMATION ||
              deleteState.kind === "working" ||
              deleteState.kind === "success"
            }
            onClick={requestDeletion}
            type="button"
          >
            {deleteState.kind === "working" ? (
              <LoaderCircle className="button-spinner" size={17} aria-hidden="true" />
            ) : (
              <Trash2 size={17} aria-hidden="true" />
            )}
            {deleteState.kind === "working" ? "Scheduling deletion…" : "Delete account data"}
          </button>
          {deleteState.kind === "success" || deleteState.kind === "error" ? (
            <p
              className={`data-control-status is-${deleteState.kind}`}
              role={deleteState.kind === "error" ? "alert" : "status"}
            >
              {deleteState.kind === "success" ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <ShieldAlert size={15} aria-hidden="true" />
              )}
              <span>{deleteState.message}</span>
            </p>
          ) : null}
        </div>
      </article>
    </section>
  );
}

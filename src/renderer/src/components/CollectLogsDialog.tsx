// ============================================================================
// CollectLogsDialog — the "Report a Problem" / "Collect Logs" modal.
// ----------------------------------------------------------------------------
// A non-technical user describes what went wrong, clicks Create Report, and the
// app drops a timestamped, REDACTED report folder + zip on their Desktop. This
// component is theme-agnostic (token-driven), so it renders correctly in BOTH
// the cargo (Aegis) and salvage (Drake) themes — it is mounted from each shell.
//
// Flow:
//   describe -> Create Report -> exporting -> success (path + "Open Folder")
//                                          \-> error  (message + retry)
// The actual fs/zip/redaction work happens in the main process behind
// window.api.exportDiagnostics({ description }); this component only drives the UI.
// ============================================================================

import { useState } from "react";
import type { ExportReportResult } from "@shared/types";

type Phase =
  | { kind: "describe" }
  | { kind: "exporting" }
  | { kind: "done"; result: ExportReportResult };

export function CollectLogsDialog({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "describe" });

  const canSubmit = description.trim().length > 0 && phase.kind === "describe";

  const submit = (): void => {
    if (!canSubmit) return;
    setPhase({ kind: "exporting" });
    void window.api
      .exportDiagnostics({ description: description.trim() })
      .then((result) => setPhase({ kind: "done", result }))
      .catch((err: unknown) =>
        setPhase({
          kind: "done",
          result: {
            outcome: "error",
            error: String(err instanceof Error ? err.message : err),
          },
        }),
      );
  };

  return (
    <>
      {/* dimmed backdrop (click-away closes only from the describe phase) */}
      <div
        onClick={phase.kind === "describe" ? onClose : undefined}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "rgba(0,0,0,0.55)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Report a problem"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          width: 520,
          maxWidth: "calc(100vw - 48px)",
          padding: 22,
          background: "var(--surface, rgba(9,16,21,0.99))",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 1.5,
            color: "var(--text-bright)",
            marginBottom: 6,
          }}
        >
          REPORT A PROBLEM
        </div>
        <p
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text-2)",
            margin: "0 0 16px",
          }}
        >
          Describe what went wrong. The app saves a report to your Desktop with
          the logs the developer needs — your Windows username and your in-game
          player name are removed automatically.
        </p>

        {phase.kind === "describe" && (
          <DescribePhase
            description={description}
            setDescription={setDescription}
            canSubmit={canSubmit}
            onSubmit={submit}
            onClose={onClose}
          />
        )}

        {phase.kind === "exporting" && (
          <div
            style={{
              padding: "20px 0",
              textAlign: "center",
              fontFamily: "var(--font-display)",
              fontSize: 13,
              color: "var(--primary)",
            }}
          >
            Collecting logs and building the report…
          </div>
        )}

        {phase.kind === "done" && (
          <DonePhase result={phase.result} onClose={onClose} />
        )}
      </div>
    </>
  );
}

function DescribePhase({
  description,
  setDescription,
  canSubmit,
  onSubmit,
  onClose,
}: {
  description: string;
  setDescription: (s: string) => void;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <>
      <textarea
        autoFocus
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="e.g. I accepted 5 hauling missions, but only the first one showed up in the list."
        rows={5}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          padding: "10px 12px",
          background: "var(--bg, rgba(0,0,0,0.3))",
          border: "1px solid var(--border-strong)",
          color: "var(--text-bright)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.5,
          outline: "none",
        }}
      />

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 16,
        }}
      >
        <button
          className="sc-ghost-btn"
          onClick={onClose}
          style={{
            padding: "9px 16px",
            background: "transparent",
            border: "1px solid var(--border-strong)",
            color: "var(--text-2)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          className="sc-primary-btn"
          onClick={onSubmit}
          disabled={!canSubmit}
          style={{
            padding: "9px 18px",
            background: canSubmit ? "var(--primary)" : "var(--border)",
            border: `1px solid ${canSubmit ? "var(--primary)" : "var(--border-strong)"}`,
            color: canSubmit ? "#04181a" : "var(--muted)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          CREATE REPORT
        </button>
      </div>
    </>
  );
}

function DonePhase({
  result,
  onClose,
}: {
  result: ExportReportResult;
  onClose: () => void;
}): React.JSX.Element {
  const ok = result.outcome === "ok";
  return (
    <>
      <div
        style={{
          padding: "12px 14px",
          border: `1px solid ${ok ? "rgba(84,224,138,0.35)" : "rgba(255,107,107,0.4)"}`,
          background: ok ? "rgba(84,224,138,0.06)" : "rgba(255,107,107,0.06)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 0.5,
            color: ok ? "var(--success)" : "var(--danger)",
            marginBottom: 6,
          }}
        >
          {ok
            ? "✓ Report saved to your Desktop"
            : "✗ Could not create the report"}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-bright)",
            wordBreak: "break-all",
            lineHeight: 1.5,
          }}
        >
          {ok
            ? (result.zip ?? result.folder ?? "")
            : (result.error ?? "Unknown error.")}
        </div>
        {ok && (
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 11,
              color: "var(--text-2)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            Send this file to the developer to report your issue.
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          marginTop: 16,
        }}
      >
        {ok && (result.folder || result.zip) && (
          <button
            className="sc-ghost-btn"
            onClick={() =>
              void window.api.openReportPath(result.zip ?? result.folder ?? "")
            }
            style={{
              padding: "9px 16px",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Open Folder
          </button>
        )}
        <button
          className="sc-primary-btn"
          onClick={onClose}
          style={{
            padding: "9px 18px",
            background: "var(--primary)",
            border: "1px solid var(--primary)",
            color: "#04181a",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          DONE
        </button>
      </div>
    </>
  );
}

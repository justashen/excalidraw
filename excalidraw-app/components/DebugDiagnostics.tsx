import React, { useState, useEffect } from "react";
import { getSessionMasterKey, getActiveEncryptionKey } from "../../packages/excalidraw/data/vault";

export interface DiagnosticState {
  backendReachable: boolean | null;
  backendMessage: string;
  vaultUnlocked: boolean;
  activeDocId: string | null;
  activeWorkspaceId: string | null;
  isLoggedIn: boolean;
  latencyMs: number | null;
  totalElements: number;
  pdfAttachments: number;
  imageElements: number;
  drawElements: number;
  selectedCount: number;
  lastAction: string;
}

export interface DebugDiagnosticsProps {
  excalidrawAPI?: any;
  onOpenTeamsLogin?: () => void;
  isOpen?: boolean;
  onClose?: () => void;
}

type TabType = "status" | "pdf-test" | "logs";

export const DebugDiagnostics: React.FC<DebugDiagnosticsProps> = ({
  excalidrawAPI,
  onOpenTeamsLogin,
  isOpen: controlledIsOpen,
  onClose,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : internalIsOpen;
  const [activeTab, setActiveTab] = useState<TabType>("status");
  const [testStatus, setTestStatus] = useState<string>("Ready to test");
  const [testColor, setTestColor] = useState<string>("#9ca3af");
  const [isTesting, setIsTesting] = useState(false);

  const setIsOpen = (open: boolean) => {
    if (controlledIsOpen !== undefined) {
      if (!open && onClose) onClose();
    } else {
      setInternalIsOpen(open);
    }
  };

  const [state, setState] = useState<DiagnosticState>({
    backendReachable: null,
    backendMessage: "Checking...",
    vaultUnlocked: false,
    activeDocId: null,
    activeWorkspaceId: null,
    isLoggedIn: false,
    latencyMs: null,
    totalElements: 0,
    pdfAttachments: 0,
    imageElements: 0,
    drawElements: 0,
    selectedCount: 0,
    lastAction: "Canvas Initialized",
  });

  const [pdfLogs, setPdfLogs] = useState<string[]>([]);

  const runDiagnostics = async () => {
    const backendUrl =
      (import.meta.env.VITE_APP_BACKEND_URL as string) ||
      (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
      "http://localhost:3002";

    const token = localStorage.getItem("team_jwt");
    const activeDoc = localStorage.getItem("active_cloud_doc");
    const activeWs = localStorage.getItem("active_workspace_id");

    const startTime = performance.now();
    let reachable = false;
    let message = "";
    let latency = 0;

    try {
      const res = await fetch(`${backendUrl}/api/health`, { method: "GET" });
      latency = Math.round(performance.now() - startTime);
      if (res.ok) {
        const json = await res.json();
        reachable = true;
        message = json.message || "Healthy";
      } else {
        message = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err: any) {
      latency = Math.round(performance.now() - startTime);
      reachable = false;
      message = err.message || "Connection refused / Backend offline";
    }

    let isUnlocked = false;
    try {
      const rawStored = sessionStorage.getItem("active_e2ee_vault_session");
      const masterKey = await getSessionMasterKey();
      const activeKey = await getActiveEncryptionKey();
      isUnlocked = !!(masterKey || activeKey || rawStored);
    } catch (vaultCheckErr) {
      console.warn("[Draw-Debug] Error checking vault status:", vaultCheckErr);
      isUnlocked = false;
    }

    setState((prev) => ({
      ...prev,
      backendReachable: reachable,
      backendMessage: message,
      vaultUnlocked: isUnlocked,
      activeDocId: activeDoc,
      activeWorkspaceId: activeWs,
      isLoggedIn: !!token,
      latencyMs: reachable ? latency : null,
    }));
  };

  // Live Canvas Element Monitoring
  useEffect(() => {
    if (!excalidrawAPI) return;

    const pollCanvasMetrics = () => {
      try {
        const elements = excalidrawAPI.getSceneElements?.() || [];
        const nonDeleted = elements.filter((el: any) => !el.isDeleted);
        let pdfCount = 0;
        let imageCount = 0;
        let drawCount = 0;

        nonDeleted.forEach((el: any) => {
          if (el.customData?.attachmentType === "pdf") {
            pdfCount++;
          } else if (el.type === "image") {
            imageCount++;
          } else {
            drawCount++;
          }
        });

        const appState = excalidrawAPI.getAppState?.() || {};
        const selectedCount = Object.keys(appState.selectedElementIds || {}).filter(
          (id) => appState.selectedElementIds[id],
        ).length;

        setState((prev) => {
          if (
            prev.totalElements === nonDeleted.length &&
            prev.pdfAttachments === pdfCount &&
            prev.imageElements === imageCount &&
            prev.selectedCount === selectedCount
          ) {
            return prev;
          }
          const action =
            nonDeleted.length > prev.totalElements
              ? `Added element (Total: ${nonDeleted.length})`
              : nonDeleted.length < prev.totalElements
              ? `Removed element (Total: ${nonDeleted.length})`
              : prev.lastAction;

          return {
            ...prev,
            totalElements: nonDeleted.length,
            pdfAttachments: pdfCount,
            imageElements: imageCount,
            drawElements: drawCount,
            selectedCount,
            lastAction: action,
          };
        });
      } catch (e) {
        // Ignore live poll errors
      }
    };

    pollCanvasMetrics();
    const liveTimer = setInterval(pollCanvasMetrics, 800);
    return () => clearInterval(liveTimer);
  }, [excalidrawAPI]);

  useEffect(() => {
    runDiagnostics();
    const interval = setInterval(runDiagnostics, 10000);
    return () => clearInterval(interval);
  }, []);

  // Listen to live PDF events
  useEffect(() => {
    const handlePdfDebugEvent = (e: any) => {
      const { step, details } = e.detail || {};
      const timeStr = new Date().toLocaleTimeString().split(" ")[0];
      const logLine = `[${timeStr}] ${step} ${details ? JSON.stringify(details) : ""}`;
      setPdfLogs((prev) => [logLine, ...prev.slice(0, 49)]);
    };

    window.addEventListener("draw-pdf-debug", handlePdfDebugEvent);
    return () => window.removeEventListener("draw-pdf-debug", handlePdfDebugEvent);
  }, []);

  // Expose global debug controller
  useEffect(() => {
    (window as any).__DRAW_DEBUG__ = true;
    (window as any).__DRAW_RUN_DIAGNOSTICS__ = runDiagnostics;
  }, []);

  // Test PDF Pipeline
  const runPdfPipelineTest = async () => {
    setIsTesting(true);
    setTestStatus("Checking authentication...");
    setTestColor("#9ca3af");

    const backendUrl =
      (import.meta.env.VITE_APP_BACKEND_URL as string) ||
      (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
      "http://localhost:3002";

    const token = localStorage.getItem("team_jwt");
    if (!token) {
      setTestStatus("Failed: Sign in required");
      setTestColor("#ef4444");
      setIsTesting(false);
      return;
    }

    setTestStatus("Checking Vault key...");
    const activeKey = await getActiveEncryptionKey();
    if (!activeKey) {
      setTestStatus("Failed: Vault locked (Key missing)");
      setTestColor("#ef4444");
      setIsTesting(false);
      return;
    }

    setTestStatus("Probing R2 storage endpoint...");
    try {
      const res = await fetch(`${backendUrl}/api/files/debug-storage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) {
        setTestStatus(`Failed: HTTP ${res.status} (${json.error || "Backend error"})`);
        setTestColor("#ef4444");
        setIsTesting(false);
        return;
      }

      if (json.s3Status.includes("error")) {
        setTestStatus(`Failed: R2 error: ${json.s3Error || "Unreachable"}`);
        setTestColor("#ef4444");
        setIsTesting(false);
        return;
      }

      setTestStatus(`Pipeline operational (${json.databaseFileRecords || 0} files in DB)`);
      setTestColor("#22c55e");
    } catch (e: any) {
      setTestStatus(`Failed: ${e.message || "Network error"}`);
      setTestColor("#ef4444");
    } finally {
      setIsTesting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 56,
        right: 16,
        width: 380,
        background: "var(--island-bg-color, #ffffff)",
        color: "var(--color-on-surface, #1f2937)",
        borderRadius: 12,
        boxShadow: "0 12px 32px -4px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)",
        border: "1px solid var(--default-border-color, #e5e7eb)",
        fontSize: 12,
        zIndex: 999999,
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: "1px solid var(--default-border-color, #e5e7eb)",
          background: "var(--color-surface-lowest, #ffffff)",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: "-0.01em" }}>
          Diagnostics & Debugger
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={runDiagnostics}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-on-surface, #4b5563)",
              cursor: "pointer",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
            }}
            title="Refresh status"
          >
            Refresh
          </button>
          <button
            onClick={() => setIsOpen(false)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-on-surface, #9ca3af)",
              cursor: "pointer",
              fontSize: 14,
              padding: "0 4px",
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--default-border-color, #e5e7eb)",
          background: "var(--color-surface-high, #f9fafb)",
        }}
      >
        <button
          onClick={() => setActiveTab("status")}
          style={{
            flex: 1,
            padding: "8px 0",
            background: activeTab === "status" ? "var(--island-bg-color, #ffffff)" : "transparent",
            border: "none",
            borderBottom: activeTab === "status" ? "2px solid var(--color-primary, #6965db)" : "2px solid transparent",
            color: activeTab === "status" ? "var(--color-on-surface, #111827)" : "var(--color-on-surface, #6b7280)",
            fontWeight: activeTab === "status" ? 600 : 500,
            cursor: "pointer",
            fontSize: 11,
            transition: "all 0.15s ease",
          }}
        >
          System Status
        </button>
        <button
          onClick={() => setActiveTab("pdf-test")}
          style={{
            flex: 1,
            padding: "8px 0",
            background: activeTab === "pdf-test" ? "var(--island-bg-color, #ffffff)" : "transparent",
            border: "none",
            borderBottom: activeTab === "pdf-test" ? "2px solid var(--color-primary, #6965db)" : "2px solid transparent",
            color: activeTab === "pdf-test" ? "var(--color-on-surface, #111827)" : "var(--color-on-surface, #6b7280)",
            fontWeight: activeTab === "pdf-test" ? 600 : 500,
            cursor: "pointer",
            fontSize: 11,
            transition: "all 0.15s ease",
          }}
        >
          PDF & Storage Test
        </button>
        <button
          onClick={() => setActiveTab("logs")}
          style={{
            flex: 1,
            padding: "8px 0",
            background: activeTab === "logs" ? "var(--island-bg-color, #ffffff)" : "transparent",
            border: "none",
            borderBottom: activeTab === "logs" ? "2px solid var(--color-primary, #6965db)" : "2px solid transparent",
            color: activeTab === "logs" ? "var(--color-on-surface, #111827)" : "var(--color-on-surface, #6b7280)",
            fontWeight: activeTab === "logs" ? 600 : 500,
            cursor: "pointer",
            fontSize: 11,
            transition: "all 0.15s ease",
          }}
        >
          Event Logs {pdfLogs.length > 0 && `(${pdfLogs.length})`}
        </button>
      </div>

      {/* Tab Content */}
      <div style={{ padding: 14, maxHeight: 320, overflowY: "auto" }}>
        {/* TAB 1: System Status */}
        {activeTab === "status" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--color-on-surface, #4b5563)" }}>Backend API:</span>
              <span
                style={{
                  fontWeight: 600,
                  color: state.backendReachable ? "#16a34a" : "#dc2626",
                }}
              >
                {state.backendReachable ? `Online (${state.latencyMs}ms)` : "Offline"}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--color-on-surface, #4b5563)" }}>E2EE Vault:</span>
              <span
                style={{
                  fontWeight: 600,
                  color: state.vaultUnlocked ? "#16a34a" : "#d97706",
                }}
              >
                {state.vaultUnlocked ? "Unlocked (Active Key)" : "Locked"}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--color-on-surface, #4b5563)" }}>Account Session:</span>
              <span style={{ fontWeight: 500 }}>
                {state.isLoggedIn ? "Signed In" : "Guest / Local"}
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--color-on-surface, #4b5563)" }}>Document:</span>
              <span
                style={{
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "monospace",
                  fontSize: 11,
                }}
              >
                {state.activeDocId || "Scratchpad"}
              </span>
            </div>

            {/* Canvas Metrics */}
            <div
              style={{
                marginTop: 4,
                padding: "8px 10px",
                background: "var(--color-surface-high, #f8f9fa)",
                borderRadius: 8,
                border: "1px solid var(--default-border-color, #e5e7eb)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 6,
                  fontWeight: 600,
                  fontSize: 11,
                }}
              >
                <span>Canvas Elements</span>
                <span>{state.totalElements} Total</span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "4px 8px",
                  fontSize: 11,
                  color: "var(--color-on-surface, #4b5563)",
                }}
              >
                <div>PDFs: <strong style={{ color: "var(--color-on-surface, #111827)" }}>{state.pdfAttachments}</strong></div>
                <div>Images: <strong style={{ color: "var(--color-on-surface, #111827)" }}>{state.imageElements}</strong></div>
                <div>Shapes: <strong style={{ color: "var(--color-on-surface, #111827)" }}>{state.drawElements}</strong></div>
                <div>Selected: <strong style={{ color: "var(--color-on-surface, #111827)" }}>{state.selectedCount}</strong></div>
              </div>
            </div>

            {/* Quick Actions */}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => {
                  localStorage.removeItem("active_cloud_doc");
                  window.location.reload();
                }}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--default-border-color, #e5e7eb)",
                  background: "var(--color-surface-high, #f3f4f6)",
                  color: "var(--color-on-surface, #374151)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                Reset Scratchpad
              </button>
              <button
                onClick={() => {
                  localStorage.removeItem("team_jwt");
                  if (onOpenTeamsLogin) onOpenTeamsLogin();
                  document.dispatchEvent(new CustomEvent("open-teams-login"));
                  window.dispatchEvent(new CustomEvent("open-teams-login"));
                }}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: "var(--color-primary, #6965db)",
                  color: "#ffffff",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                Re-authenticate
              </button>
            </div>
          </div>
        )}

        {/* TAB 2: PDF & Storage Test */}
        {activeTab === "pdf-test" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--color-on-surface, #6b7280)", lineHeight: 1.4 }}>
              Test the end-to-end PDF pipeline, Cloudflare R2 bucket connection, and deletion workflow.
            </p>

            <div
              style={{
                padding: "8px 10px",
                background: "var(--color-surface-high, #f8f9fa)",
                borderRadius: 8,
                border: "1px solid var(--default-border-color, #e5e7eb)",
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>Pipeline Output</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(testStatus);
                        const btn = document.getElementById("copy-test-btn");
                        if (btn) {
                          btn.textContent = "Copied";
                          setTimeout(() => {
                            if (btn) btn.textContent = "Copy";
                          }, 1500);
                        }
                      } catch (e) {
                        console.error("Failed to copy test status", e);
                      }
                    }}
                    id="copy-test-btn"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      background: "var(--island-bg-color, #ffffff)",
                      border: "1px solid var(--default-border-color, #e5e7eb)",
                      borderRadius: 4,
                      color: "var(--color-on-surface, #374151)",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: "2px 6px",
                      fontWeight: 500,
                    }}
                    title="Copy test output"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                    </svg>
                    Copy
                  </button>

                  <button
                    onClick={() => {
                      setTestStatus("Ready to test");
                      setTestColor("#9ca3af");
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      background: "transparent",
                      border: "1px solid transparent",
                      borderRadius: 4,
                      color: "var(--color-on-surface, #6b7280)",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: "2px 6px",
                    }}
                    title="Clear test output"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18"/>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                    Clear
                  </button>
                </div>
              </div>
              <div style={{ color: testColor, wordBreak: "break-all", fontFamily: "monospace", fontSize: 10, lineHeight: 1.4 }}>
                {testStatus}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
              <button
                onClick={runPdfPipelineTest}
                disabled={isTesting}
                style={{
                  width: "100%",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: "var(--color-primary, #6965db)",
                  color: "#ffffff",
                  cursor: isTesting ? "not-allowed" : "pointer",
                  fontSize: 11,
                  fontWeight: 500,
                  opacity: isTesting ? 0.7 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
                  <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
                  <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
                  <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
                </svg>
                {isTesting ? "Testing..." : "Test Full PDF Pipeline (E2EE + R2)"}
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: Event Logs */}
        {activeTab === "logs" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-on-surface, #6b7280)" }}>
                Live PDF & Storage Events
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {pdfLogs.length > 0 && (
                  <button
                    onClick={async () => {
                      const fullReport = [
                        `=== DRAW DIAGNOSTICS REPORT ===`,
                        `Timestamp: ${new Date().toISOString()}`,
                        `Backend: ${state.backendReachable ? "Connected" : "Disconnected"} (${state.backendMessage})`,
                        `Vault: ${state.vaultUnlocked ? "Unlocked" : "Locked"}`,
                        `Session: ${state.isLoggedIn ? "Signed In" : "Anonymous"}`,
                        `Cloud Doc: ${state.activeDocId || "None"}`,
                        `Workspace: ${state.activeWorkspaceId || "None"}`,
                        `Canvas Elements: ${state.totalElements} (PDFs: ${state.pdfAttachments}, Images: ${state.imageElements}, Shapes: ${state.drawElements})`,
                        `\n=== PDF EVENT LOGS (${pdfLogs.length}) ===`,
                        ...pdfLogs,
                      ].join("\n");

                      try {
                        await navigator.clipboard.writeText(fullReport);
                        const btn = document.getElementById("copy-logs-btn");
                        if (btn) {
                          btn.textContent = "Copied";
                          setTimeout(() => {
                            if (btn) btn.textContent = "Copy Report";
                          }, 2000);
                        }
                      } catch (copyErr) {
                        console.error("Failed to copy logs:", copyErr);
                      }
                    }}
                    id="copy-logs-btn"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      background: "var(--color-surface-high, #f3f4f6)",
                      border: "1px solid var(--default-border-color, #e5e7eb)",
                      borderRadius: 4,
                      color: "var(--color-on-surface, #374151)",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: "2px 7px",
                      fontWeight: 500,
                    }}
                    title="Copy full diagnostic report & logs to clipboard"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                    </svg>
                    <span>Copy Report</span>
                  </button>
                )}
                {pdfLogs.length > 0 && (
                  <button
                    onClick={() => setPdfLogs([])}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      background: "none",
                      border: "none",
                      color: "var(--color-on-surface, #9ca3af)",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: "2px 5px",
                    }}
                    title="Clear event logs"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18"/>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                    <span>Clear</span>
                  </button>
                )}
              </div>
            </div>

            <div
              style={{
                maxHeight: 180,
                overflowY: "auto",
                background: "var(--color-surface-high, #f8f9fa)",
                border: "1px solid var(--default-border-color, #e5e7eb)",
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 10,
                fontFamily: "monospace",
                color: "var(--color-on-surface, #1f2937)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {pdfLogs.length === 0 ? (
                <span style={{ color: "var(--color-on-surface, #9ca3af)", fontStyle: "italic" }}>
                  No recent events. Upload, open, or delete a PDF to stream real-time events...
                </span>
              ) : (
                pdfLogs.map((log, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        log.includes("FAILED") || log.includes("Failed") || log.includes("Error")
                          ? "#dc2626"
                          : log.includes("Deleted") || log.includes("success")
                          ? "#16a34a"
                          : "var(--color-on-surface, #374151)",
                      wordBreak: "break-all",
                      lineHeight: 1.35,
                    }}
                  >
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

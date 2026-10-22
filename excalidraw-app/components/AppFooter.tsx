import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { isExcalidrawPlusSignedUser } from "../app_constants";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";
import { DurowaveIcon } from "./DurowaveIcon";

export const AppFooter = React.memo(
  ({
    onChange,
    onToggleDiagnostics,
    isDiagnosticsOpen,
  }: {
    onChange: () => void;
    onToggleDiagnostics?: () => void;
    isDiagnosticsOpen?: boolean;
  }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          <a
            href="https://durowave.co?ref=draw"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              width: "2.5rem",
              height: "2.5rem",
              borderRadius: "var(--border-radius-lg)",
              backgroundColor: "var(--color-surface-lowest)",
              border: "1px solid var(--color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
              textDecoration: "none"
            }}
            aria-label="Durowave"
          >
            <DurowaveIcon style={{ width: '1.2rem', height: '1.2rem', color: 'grey' }} />
          </a>
          {onToggleDiagnostics && (
            <button
              type="button"
              onClick={onToggleDiagnostics}
              style={{
                width: "2.5rem",
                height: "2.5rem",
                borderRadius: "var(--border-radius-lg)",
                backgroundColor: isDiagnosticsOpen
                  ? "var(--color-surface-low, #e5e7eb)"
                  : "var(--color-surface-lowest)",
                border: "1px solid var(--color-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
                color: isDiagnosticsOpen ? "var(--color-primary, #6965db)" : "grey",
                transition: "all 0.15s ease",
              }}
              title="System Diagnostics & Debugger"
              aria-label="System Diagnostics"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m8 2 1.88 1.88" />
                <path d="M14.12 3.88 16 2" />
                <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
                <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
                <path d="M12 20v-9" />
                <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
                <path d="M6 13H2" />
                <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
                <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
                <path d="M22 13h-4" />
                <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
              </svg>
            </button>
          )}
          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
        </div>
      </Footer>
    );
  },
);

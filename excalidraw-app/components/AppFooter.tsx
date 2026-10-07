import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { isExcalidrawPlusSignedUser } from "../app_constants";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";
import { DurowaveIcon } from "./DurowaveIcon";

export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
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
          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
        </div>
      </Footer>
    );
  },
);

import { actionClearCanvas } from "../actions";
import { atom, useAtom } from "../editor-jotai";
import { t } from "../i18n";

import { useExcalidrawActionManager } from "./App";
import ConfirmDialog from "./ConfirmDialog";

export type ActiveConfirmDialogState =
  | "clearCanvas"
  | {
      type: "deletePdf";
      filename?: string;
      onConfirm: () => void;
    }
  | null;

export const activeConfirmDialogAtom = atom<ActiveConfirmDialogState>(null);

export const ActiveConfirmDialog = () => {
  const [activeConfirmDialog, setActiveConfirmDialog] = useAtom(
    activeConfirmDialogAtom,
  );
  const actionManager = useExcalidrawActionManager();

  if (!activeConfirmDialog) {
    return null;
  }

  if (activeConfirmDialog === "clearCanvas") {
    return (
      <ConfirmDialog
        onConfirm={() => {
          actionManager.executeAction(actionClearCanvas);
          setActiveConfirmDialog(null);
        }}
        onCancel={() => setActiveConfirmDialog(null)}
        title={t("clearCanvasDialog.title")}
      >
        <p className="clear-canvas__content"> {t("alerts.clearReset")}</p>
      </ConfirmDialog>
    );
  }

  if (typeof activeConfirmDialog === "object" && activeConfirmDialog.type === "deletePdf") {
    return (
      <ConfirmDialog
        className="confirm-dialog--pdf-delete"
        onConfirm={() => {
          activeConfirmDialog.onConfirm();
          setActiveConfirmDialog(null);
        }}
        onCancel={() => setActiveConfirmDialog(null)}
        confirmText="Delete"
        cancelText="Cancel"
        title="Delete attachment?"
      >
        <div className="pdf-delete-confirm">
          <p className="pdf-delete-confirm__prompt">
            {activeConfirmDialog.filename ? (
              <>
                <span
                  className="pdf-delete-confirm__filename"
                  title={activeConfirmDialog.filename}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ color: "#e02424", flexShrink: 0 }}
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span>{activeConfirmDialog.filename}</span>
                </span>
                <span>will be permanently removed.</span>
              </>
            ) : (
              <span>This attachment will be permanently removed.</span>
            )}
          </p>
        </div>
      </ConfirmDialog>
    );
  }

  return null;
};

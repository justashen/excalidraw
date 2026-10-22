import React, { useState } from "react";
import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import { getElementAbsoluteCoords } from "@excalidraw/element";
import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import { useExcalidrawAppState } from "./App";
import { fetchAndDecryptPdf } from "../data/pdf";
import "./PdfAttachmentCard.scss";
import type { AppState } from "../types";

const getPdfCardCoords = (
  element: NonDeletedExcalidrawElement,
  appState: AppState,
  elementsMap: ElementsMap,
) => {
  const [x1, , , y2] = getElementAbsoluteCoords(element, elementsMap);
  const { x: viewportX, y: viewportY } = sceneCoordsToViewportCoords(
    { sceneX: x1, sceneY: y2 },
    appState,
  );
  const x = viewportX - appState.offsetLeft;
  const y = viewportY - appState.offsetTop + 10;
  return { x, y };
};

export const PdfAttachmentCard: React.FC<{
  element: NonDeletedExcalidrawElement;
  elementsMap: ElementsMap;
  onDelete: () => void;
  setToast: (toast: { message: string; closable?: boolean; duration?: number } | null) => void;
}> = ({ element, elementsMap, setToast }) => {
  const appState = useExcalidrawAppState();
  const [isOpening, setIsOpening] = useState(false);

  if (
    appState.contextMenu ||
    appState.newElement ||
    appState.resizingElement ||
    appState.isRotating ||
    appState.openMenu ||
    appState.viewModeEnabled
  ) {
    return null;
  }

  const customData = (element as any).customData;
  if (!customData || customData.attachmentType !== "pdf") {
    return null;
  }

  const { x, y } = getPdfCardCoords(element, appState, elementsMap);
  const fileName = customData.filename || "Document.pdf";

  const handleOpenPdf = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isOpening) return;
    setIsOpening(true);

    setToast({
      message: "Decrypting document...",
      duration: 3000,
      closable: true,
    });

    try {
      const decryptedBlobUrl = await fetchAndDecryptPdf(
        customData.fileId,
        customData.ivHex,
      );
      const newTab = window.open(decryptedBlobUrl, "_blank");
      if (newTab) {
        newTab.opener = null;
      }
    } catch (err: any) {
      console.error("Failed to decrypt and open PDF:", err);
      setToast({
        message: `Could not open document: ${err.message}`,
        duration: 5000,
        closable: true,
      });
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <div
      className="excalidraw-pdf-card"
      style={{
        transform: `translate(${x}px, ${y}px)`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="excalidraw-pdf-card__icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </div>

      <span className="excalidraw-pdf-card__name" title={fileName}>
        {fileName}
      </span>

      <button
        type="button"
        className="excalidraw-pdf-card__btn"
        onClick={handleOpenPdf}
        disabled={isOpening}
        title="Open in new tab"
      >
        <span>{isOpening ? "Decrypting..." : "Open"}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ marginLeft: 4 }}
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
    </div>
  );
};

import * as pdfjsLib from "pdfjs-dist";

// Use local bundled worker to prevent supply-chain security risks from third-party CDNs
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export const generatePdfThumbnail = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  
  // Load the PDF
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) } as any);
  const pdf = await loadingTask.promise;
  
  // Fetch the first page
  const page = await pdf.getPage(1);
  
  // Set scale for thumbnail (e.g., scale to reasonable resolution)
  const scale = 1.5;
  const viewport = page.getViewport({ scale });
  
  // Prepare canvas using HTML5 canvas
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create canvas context");
  }
  
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  
  // Render PDF page into canvas context
  const renderContext = {
    canvasContext: context,
    viewport: viewport,
  };
  
  await page.render(renderContext as any).promise;
  
  // Draw a simple "PDF" badge on top to indicate it's an attachment
  context.fillStyle = "rgba(255, 0, 0, 0.8)";
  context.fillRect(10, 10, 80, 40);
  context.fillStyle = "white";
  context.font = "bold 20px Arial";
  context.fillText("PDF", 30, 38);
  
  // Return as base64 PNG data URL
  return canvas.toDataURL("image/png");
};

export const regeneratePdfThumbnail = async (
  fileId: string,
  ivHex?: string,
): Promise<string> => {
  const decryptedBlobUrl = await fetchAndDecryptPdf(fileId, ivHex);
  try {
    const res = await fetch(decryptedBlobUrl);
    const blob = await res.blob();
    const file = new File([blob], "document.pdf", { type: "application/pdf" });
    return await generatePdfThumbnail(file);
  } finally {
    URL.revokeObjectURL(decryptedBlobUrl);
  }
};

const BACKEND_URL =
  (import.meta.env.VITE_APP_BACKEND_URL as string) ||
  (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
  "http://localhost:3002";

import {
  encryptBinary,
  decryptBinary,
  getActiveEncryptionKey,
} from "./vault";

export const processAndUploadPdf = async (
  file: File,
): Promise<{ thumbnailDataUrl: string; fileId: string; ivHex: string }> => {
  const token = localStorage.getItem("team_jwt") || "";
  if (!token) {
    throw new Error("Authentication required: Please sign in to upload PDF documents.");
  }

  const emitPdfDebug = (step: string, details?: any) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("draw-pdf-debug", {
          detail: { step, timestamp: Date.now(), details },
        }),
      );
      if ((window as any).__DRAW_DEBUG__) {
        console.log(`[PDF-Pipeline Debug] ${step}`, details || "");
      }
    }
  };

  const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `File size (${sizeMB} MB) exceeds maximum permitted attachment limit of 100 MB. Please attach a document under 100 MB.`,
    );
  }

  emitPdfDebug("Starting PDF Attachment Flow", { filename: file.name, sizeBytes: file.size });

  // 1. Generate thumbnail client-side
  emitPdfDebug("1/5: Rendering Client-Side PDF Thumbnail...");
  const thumbnailDataUrl = await generatePdfThumbnail(file);
  emitPdfDebug("1/5: Thumbnail Generated Successfully");

  // 2. Encrypt the raw PDF file with the active workspace DEK (Fail-closed)
  emitPdfDebug("2/5: Deriving AES-GCM 256 E2EE Vault Key...");
  const encryptionKey = await getActiveEncryptionKey();
  if (!encryptionKey) {
    emitPdfDebug("2/5 FAILED: Encryption key unavailable", { error: "Vault locked" });
    throw new Error(
      "Encryption key unavailable: Cannot securely encrypt PDF attachment for this workspace. Upload aborted to prevent plaintext leakage.",
    );
  }

  emitPdfDebug("2/5: Encrypting PDF Bytes Client-Side (AES-GCM)...");
  const encryptedResult = await encryptBinary(file, encryptionKey);
  const bodyToUpload: Blob = encryptedResult.encryptedBlob;
  const ivHex: string = encryptedResult.ivHex;
  emitPdfDebug("2/5: PDF Bytes Encrypted Client-Side", {
    ivHex: ivHex.substring(0, 12) + "...",
    cipherSizeBytes: bodyToUpload.size,
  });

  // 3. Get pre-signed POST upload policy from backend
  let activeDocId = localStorage.getItem("active_cloud_doc");
  if (!activeDocId) {
    // Attempt auto-resolution: find the user's first workspace and its documents, or create one
    try {
      let workspaceId = localStorage.getItem("active_workspace_id");
      if (!workspaceId) {
        const wsRes = await fetch(`${BACKEND_URL}/api/workspaces`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (wsRes.ok) {
          const wsList = await wsRes.json();
          if (Array.isArray(wsList) && wsList.length > 0) {
            workspaceId = wsList[0].id;
            localStorage.setItem("active_workspace_id", workspaceId!);
          }
        }
      }

      if (workspaceId) {
        const docsRes = await fetch(`${BACKEND_URL}/api/documents/workspace/${encodeURIComponent(workspaceId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (docsRes.ok) {
          const docs = await docsRes.json();
          if (Array.isArray(docs) && docs.length > 0) {
            activeDocId = docs[0].id;
            localStorage.setItem("active_cloud_doc", activeDocId!);
          } else {
            // Create default document in this workspace
            const createRes = await fetch(`${BACKEND_URL}/api/documents/workspace/${encodeURIComponent(workspaceId)}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ title: "My Workspace Canvas", data: {} }),
            });
            if (createRes.ok) {
              const newDoc = await createRes.json();
              activeDocId = newDoc.id;
              localStorage.setItem("active_cloud_doc", activeDocId!);
            }
          }
        }
      }
    } catch (resolveErr) {
      console.warn("Could not auto-resolve workspace document", resolveErr);
    }
  }

  if (!activeDocId) {
    throw new Error("Please open or select a document in your workspace before attaching PDF files.");
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/files/upload-url`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}` 
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: "application/octet-stream",
        documentId: activeDocId,
      })
    });
  } catch (netErr: any) {
    console.error("Network error requesting upload URL from backend:", netErr);
    throw new Error(`Failed to connect to backend at ${BACKEND_URL} (${netErr.message || "Network request failed"})`);
  }

  let postData: any = null;
  let fileId = "";

  if (res.ok) {
    postData = await res.json();
    fileId = postData.fileId;
  } else {
    console.warn(`upload-url returned ${res.status}. Attempting direct streaming upload...`);
  }

  let uploadSucceeded = false;

  // 4. Try direct upload to R2 using Presigned POST FormData if available
  if (postData?.fields) {
    try {
      const formData = new FormData();
      Object.entries(postData.fields).forEach(([k, v]) => {
        formData.append(k, v as string);
      });
      formData.append("file", bodyToUpload);

      const uploadRes = await fetch(postData.url, {
        method: "POST",
        body: formData,
      });

      if (uploadRes.ok || uploadRes.status === 204) {
        uploadSucceeded = true;
        emitPdfDebug("4/5: Uploaded directly to R2 bucket");
      } else {
        emitPdfDebug(`Direct R2 upload returned ${uploadRes.status}, streaming via backend...`);
      }
    } catch (r2Err) {
      emitPdfDebug("Direct R2 upload failed, streaming via backend...", r2Err);
    }
  }

  // 4b. Reliable Fallback: Stream encrypted bytes directly through backend to R2
  if (!uploadSucceeded) {
    emitPdfDebug("3/5: Streaming Encrypted PDF via Backend to Storage...");
    const directRes = await fetch(`${BACKEND_URL}/api/files/upload-direct`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "x-file-id": fileId || "",
        "x-document-id": activeDocId,
        "x-filename": encodeURIComponent(file.name),
      },
      body: bodyToUpload,
    });

    if (!directRes.ok) {
      const rawText = await directRes.text().catch(() => "");
      let errMsg = `Failed to upload file to storage (HTTP ${directRes.status})`;
      try {
        const parsed = JSON.parse(rawText);
        if (parsed?.error) errMsg = parsed.error;
      } catch {
        if (rawText) errMsg = rawText;
      }
      emitPdfDebug("Upload Failed:", { error: errMsg });
      throw new Error(errMsg);
    }

    const directData = await directRes.json();
    if (directData?.fileId) {
      fileId = directData.fileId;
    }
    uploadSucceeded = true;
    emitPdfDebug("4/5: Encrypted PDF Stored in R2 Successfully", { fileId });
  }

  // 5. Confirm upload with backend to register verified DocumentFile
  try {
    emitPdfDebug("5/5: Registering PDF in Database & Generating Canvas Card...");
    await fetch(`${BACKEND_URL}/api/files/confirm-upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fileId,
        documentId: activeDocId,
        filename: file.name,
        contentType: "application/octet-stream",
      }),
    });
    emitPdfDebug("✅ PDF Encrypted & Attached to Canvas Successfully!", { fileId });
  } catch (confirmErr) {
    console.warn("Failed to notify backend of file upload completion", confirmErr);
  }

  return { thumbnailDataUrl, fileId, ivHex };
};

/**
 * Download and decrypt an encrypted PDF file on demand
 */
export const fetchAndDecryptPdf = async (
  fileId: string,
  ivHex?: string,
): Promise<string> => {
  const emitPdfDebug = (step: string, details?: any) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("draw-pdf-debug", {
          detail: { step, timestamp: Date.now(), details },
        }),
      );
      if ((window as any).__DRAW_DEBUG__) {
        console.log(`[PDF-Pipeline Debug] ${step}`, details || "");
      }
    }
  };

  emitPdfDebug("1/4: Requesting Authorized Download URL for Attachment...", { fileId });
  const token = localStorage.getItem("team_jwt") || "";
  const res = await fetch(`${BACKEND_URL}/api/files/${encodeURIComponent(fileId)}?action=download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    emitPdfDebug(`Download authorization failed: HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error("Access denied: You do not have permission to view this file.");
    }
    throw new Error("Could not access file");
  }
  const { url, directUrl } = await res.json();

  let buffer: ArrayBuffer;
  emitPdfDebug("2/4: Fetching Encrypted Ciphertext Payload from Storage...");
  try {
    const fileDataRes = await fetch(url);
    if (!fileDataRes.ok) throw new Error(`HTTP ${fileDataRes.status}`);
    buffer = await fileDataRes.arrayBuffer();
    emitPdfDebug("2/4: Downloaded ciphertext directly from R2");
  } catch (dlErr) {
    // If direct R2 fetch fails (e.g. CORS), fallback to backend proxy stream
    emitPdfDebug("Direct R2 fetch failed, streaming via backend content proxy...");
    const fallbackUrl = directUrl ? `${BACKEND_URL}${directUrl}` : `${BACKEND_URL}/api/files/${encodeURIComponent(fileId)}/content`;
    const fallbackRes = await fetch(fallbackUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!fallbackRes.ok) {
      emitPdfDebug("Proxy download failed");
      throw new Error("Could not download file from storage");
    }
    buffer = await fallbackRes.arrayBuffer();
    emitPdfDebug("2/4: Downloaded ciphertext via Backend Proxy");
  }

  if (!ivHex) {
    emitPdfDebug("3/4: Legacy unencrypted PDF, creating blob URL...");
    const blob = new Blob([buffer], { type: "application/pdf" });
    return URL.createObjectURL(blob);
  }

  emitPdfDebug("3/4: Retrieving Client-Side Master Key to Decrypt...");
  const activeKey = await getActiveEncryptionKey();
  if (!activeKey) {
    emitPdfDebug("3/4 FAILED: Vault encryption key missing from session memory");
    throw new Error("Cannot decrypt file: Vault encryption key is not present in session");
  }

  emitPdfDebug("3/4: Running AES-GCM Client Decryption on Buffer...");
  const decryptedBlob = await decryptBinary(buffer, ivHex, "application/pdf", activeKey);
  const blobUrl = URL.createObjectURL(decryptedBlob);
  emitPdfDebug("✅ 4/4: PDF Decrypted & Ready to Display in Browser!", { blobUrl });
  return blobUrl;
  return URL.createObjectURL(decryptedBlob);
};

/**
 * Delete a PDF document attachment from R2 storage and the backend
 */
export const deletePdfAttachment = async (fileId: string): Promise<boolean> => {
  const token = localStorage.getItem("team_jwt") || "";
  if (!token || !fileId) return false;

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("draw-pdf-debug", {
        detail: {
          step: "Deleting PDF from Storage",
          details: { fileId },
        },
      }),
    );
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("draw-pdf-debug", {
          detail: {
            step: res.ok ? "Deleted PDF Permanently" : "Delete Failed",
            details: { fileId, status: res.status, statusText: res.statusText },
          },
        }),
      );
    }

    return res.ok;
  } catch (err: any) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("draw-pdf-debug", {
          detail: {
            step: "Delete Error",
            details: { fileId, error: err?.message || String(err) },
          },
        }),
      );
    }
    console.warn("Failed to delete PDF file from storage", err);
    return false;
  }
};

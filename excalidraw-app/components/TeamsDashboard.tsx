import React, { useState, useEffect } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import {
  deriveKeysFromPassword,
  exportAndEncryptMasterKey,
  getSessionMasterKey,
  generateWorkspaceDek,
  wrapWorkspaceDekForSelf,
  wrapWorkspaceDekForRecipient,
  getOrFetchWorkspaceDek,
  setCachedWorkspaceDek,
} from "@excalidraw/excalidraw/data/vault";
import { BACKEND_URL } from "../app_constants";
import "./TeamsDashboard.scss";

interface TeamsDashboardProps {
  onClose: () => void;
  onOpenDocument: (documentId: string, workspaceName: string) => void;
}

export const TeamsDashboard: React.FC<TeamsDashboardProps> = ({
  onClose,
  onOpenDocument,
}) => {
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<any>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: "error" | "success";
  } | null>(null);
  const [showAllDocuments, setShowAllDocuments] = useState(false);

  const token = localStorage.getItem("team_jwt");

  useEffect(() => {
    if (token) {
      fetchWorkspaces();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const fetchWorkspaces = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) {
        const safeData = Array.isArray(data) ? data : [];
        setWorkspaces(safeData);
        if (safeData.length > 0 && !selectedWorkspace) {
          selectWorkspace(safeData[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const selectWorkspace = async (workspace: any) => {
    setSelectedWorkspace(workspace);
    localStorage.setItem("active_workspace_id", workspace.id);
    setShowAllDocuments(false); // Reset view when changing workspace
    // Proactively pre-fetch and unwrap workspace DEK
    getOrFetchWorkspaceDek(workspace.id, token || undefined).catch(console.warn);

    try {
      const res = await fetch(
        `${BACKEND_URL}/api/documents/workspace/${workspace.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = await res.json();
      if (res.ok) {
        setDocuments(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const createWorkspace = async () => {
    if (!newWorkspaceName || !newWorkspaceName.trim()) {
      return;
    }

    try {
      const masterKey = await getSessionMasterKey();
      let encryptedDek: string | undefined = undefined;
      let dek: CryptoKey | null = null;
      if (masterKey) {
        dek = await generateWorkspaceDek();
        encryptedDek = await wrapWorkspaceDekForSelf(dek, masterKey);
      }

      const res = await fetch(`${BACKEND_URL}/api/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newWorkspaceName.trim(), encryptedDek }),
      });
      const data = await res.json();
      if (res.ok) {
        if (dek && data.id) {
          setCachedWorkspaceDek(data.id, dek);
        }
        setNewWorkspaceName("");
        fetchWorkspaces();
      }
    } catch (e) {
      console.error("Workspace creation failed", e);
    }
  };

  const inviteMember = async () => {
    if (!inviteEmail || !selectedWorkspace) {
      return;
    }

    try {
      // 1. Fetch invitee's public key for ECIES DEK wrapping
      let encryptedDek: string | undefined = undefined;
      try {
        const pubKeyRes = await fetch(
          `${BACKEND_URL}/api/auth/public-key?email=${encodeURIComponent(inviteEmail.trim())}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (pubKeyRes.ok) {
          const pubKeyData = await pubKeyRes.json();
          if (pubKeyData.publicKey) {
            const dek = await getOrFetchWorkspaceDek(selectedWorkspace.id, token || undefined);
            if (dek) {
              encryptedDek = await wrapWorkspaceDekForRecipient(dek, pubKeyData.publicKey);
            }
          }
        }
      } catch (keyErr) {
        console.warn("Could not wrap DEK for invitee", keyErr);
      }

      const res = await fetch(
        `${BACKEND_URL}/api/workspaces/${selectedWorkspace.id}/invite`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ email: inviteEmail.trim(), role: "EDITOR", encryptedDek }),
        },
      );
      if (res.ok) {
        setInviteEmail("");
        setStatusMessage({
          text: "Member invited and Workspace DEK safely shared!",
          type: "success",
        });
      } else {
        const errorData = await res.json().catch(() => ({}));
        setStatusMessage({
          text:
            errorData.error || "Failed to invite member. Are they registered?",
          type: "error",
        });
      }
    } catch (e) {
      console.error("Invite error", e);
    }
  };

  const createDocument = async () => {
    if (!selectedWorkspace) {
      return;
    }
    const res = await fetch(
      `${BACKEND_URL}/api/documents/workspace/${selectedWorkspace.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: "New Drawing", data: {} }), // Send basic payload to start
      },
    );
    const data = await res.json();
    if (res.ok) {
      onOpenDocument(data.id, selectedWorkspace.id);
      onClose();
    } else {
      setStatusMessage({
        text: data.error || "Failed to create document.",
        type: "error",
      });
    }
  };

  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setStatusMessage({ text: "New password must be at least 8 characters long.", type: "error" });
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatusMessage({ text: "New passwords do not match.", type: "error" });
      return;
    }

    setPwdLoading(true);
    setStatusMessage(null);

    try {
      // 1. Get active session master key from client memory
      const masterKey = await getSessionMasterKey();
      if (!masterKey) {
        setStatusMessage({
          text: "Session master key missing. Please log out and back in.",
          type: "error",
        });
        setPwdLoading(false);
        return;
      }

      // 2. Decode user email from JWT
      const base64Url = token!.split(".")[1];
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const userPayload = JSON.parse(window.atob(base64));
      const email = userPayload.email;

      // 3. Fetch user's registered cryptographic salt for accurate current auth hash calculation
      let currentSalt: string | undefined = undefined;
      try {
        const saltRes = await fetch(
          `${BACKEND_URL}/api/auth/salt?email=${encodeURIComponent(email)}`,
        );
        if (saltRes.ok) {
          const saltData = await saltRes.json();
          currentSalt = saltData.salt || undefined;
        }
      } catch (saltErr) {
        console.warn("Could not fetch remote user salt for password change", saltErr);
      }

      // 4. Derive current auth hash using the registered salt
      const { authHash: currentAuthHash } = await deriveKeysFromPassword(currentPassword, email, currentSalt);

      // 5. Derive new KEK and new Auth Hash with a fresh cryptographically secure random salt
      const { authHash: newAuthHash, kek: newKek, saltHex: newSaltHex } =
        await deriveKeysFromPassword(newPassword, email);

      // 4. Re-wrap the existing master key with the new KEK
      const newEncryptedMasterKey = await exportAndEncryptMasterKey(masterKey, newKek);

      // 5. Send re-wrapped vault to backend
      const res = await fetch(`${BACKEND_URL}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword: currentAuthHash,
          newPassword: newAuthHash,
          newEncryptedMasterKey,
          newPasswordSalt: newSaltHex,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatusMessage({
          text: "E2EE Vault & Password updated successfully!",
          type: "success",
        });
        setShowPasswordChange(false);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        setStatusMessage({
          text: data.error || "Failed to change password.",
          type: "error",
        });
      }
    } catch (err) {
      console.error(err);
      setStatusMessage({
        text: "Error updating Zero-Knowledge vault.",
        type: "error",
      });
    } finally {
      setPwdLoading(false);
    }
  };

  return (
    <Dialog
      onCloseRequest={onClose}
      title="Teams Dashboard"
      className="TeamsDashboard"
    >
      {statusMessage && (
        <div style={{
          padding: "10px",
          marginBottom: "15px",
          borderRadius: "var(--border-radius-lg, 8px)",
          background: statusMessage.type === "success" ? "var(--color-success)" : "var(--color-danger)",
          color: "white",
          textAlign: "center"
        }}>
          {statusMessage.text}
        </div>
      )}
      <div className="td-dashboard-container">
        {/* Sidebar: Workspaces */}
        <div className="td-sidebar">
          <h4>My Workspaces</h4>
          <div className="td-workspace-list">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => selectWorkspace(ws)}
                className={selectedWorkspace?.id === ws.id ? "active" : ""}
              >
                {ws.name} ({ws.role})
              </button>
            ))}
          </div>
          <div className="td-create-workspace">
            <input
              type="text"
              placeholder="New Workspace"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              onClick={createWorkspace}
              className="btn-secondary"
            >
              Create
            </button>
          </div>
          <div style={{ marginTop: "15px", paddingTop: "15px", borderTop: "1px solid var(--color-gray-20)" }}>
            <button
              onClick={() => setShowPasswordChange(!showPasswordChange)}
              className="btn-secondary"
              style={{ width: "100%", fontSize: "0.85rem" }}
            >
              {showPasswordChange ? "Back to Drawings" : "Vault & Security"}
            </button>
          </div>
        </div>

        {/* Main Content: Documents or Security Settings */}
        <div className="td-main-content">
          {showPasswordChange ? (
            <div style={{ padding: "10px", maxWidth: "420px" }}>
              <h4>Zero-Knowledge Security Settings</h4>
              <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary, #666)", margin: "8px 0 16px" }}>
                Changing your password will re-encrypt your Master Data Key with a new Key Encryption Key (KEK) client-side so you never lose access to your encrypted drawings and PDFs.
              </p>
              <form onSubmit={handleChangePassword} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <input
                  type="password"
                  placeholder="Current Password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  required
                />
                <input
                  type="password"
                  placeholder="New Password (min 8 chars)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  required
                />
                <input
                  type="password"
                  placeholder="Confirm New Password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  required
                />
                <button
                  type="submit"
                  disabled={pwdLoading}
                  className="btn-primary"
                  style={{ marginTop: "10px" }}
                >
                  {pwdLoading ? "Re-encrypting Vault..." : "Update Vault & Password"}
                </button>
              </form>
            </div>
          ) : selectedWorkspace ? (
            showAllDocuments ? (
              // DEDICATED FULL VIEW FOR DOCUMENTS
              <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                <div className="td-header">
                  <h4>All Documents in {selectedWorkspace.name}</h4>
                  <div>
                    <button
                      onClick={() => setShowAllDocuments(false)}
                      className="btn-secondary"
                      style={{ marginRight: "10px" }}
                    >
                      Back to Dashboard
                    </button>
                    <button
                      onClick={createDocument}
                      className="btn-primary"
                    >
                      + New Drawing
                    </button>
                  </div>
                </div>
                <div className="td-documents-grid">
                  {documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="td-document-card"
                      onClick={() => { onOpenDocument(doc.id, selectedWorkspace.name); onClose(); }}
                    >
                      <strong>{doc.title}</strong>
                      <div className="td-date">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              // STANDARD DASHBOARD VIEW
              <>
                <div className="td-header">
                  <h4>{selectedWorkspace.name} Documents</h4>
                  <button
                    onClick={createDocument}
                    className="btn-primary"
                  >
                    + New Drawing
                  </button>
                </div>

                <div className="td-documents-grid">
                  {documents.length === 0 ? (
                    <p>No documents yet.</p>
                  ) : (
                    documents.slice(0, 3).map((doc) => (
                      <div
                        key={doc.id}
                        className="td-document-card"
                        onClick={() => { onOpenDocument(doc.id, selectedWorkspace.name); onClose(); }}
                      >
                        <strong>{doc.title}</strong>
                        <div className="td-date">
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    ))
                  )}
                  {documents.length > 3 && (
                    <div style={{ width: "100%" }}>
                      <button 
                        onClick={() => setShowAllDocuments(true)}
                        className="td-view-all-btn"
                      >
                        View All {documents.length} Drawings...
                      </button>
                    </div>
                  )}
                </div>

                {selectedWorkspace.role === "ADMIN" && (
                  <div className="td-invite-section">
                    <h5>Invite Member</h5>
                    <div className="td-invite-form">
                      <input
                        type="email"
                        placeholder="Member Email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                      <button onClick={inviteMember} className="btn-secondary">
                        Invite
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          ) : (
            <p>Select or create a workspace to view documents.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
};

import React, { useState, useEffect } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
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
    const res = await fetch("http://localhost:3002/api/workspaces", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok) {
      setWorkspaces(data);
      if (data.length > 0 && !selectedWorkspace) {
        selectWorkspace(data[0]);
      }
    }
  };

  const selectWorkspace = async (workspace: any) => {
    setSelectedWorkspace(workspace);
    setShowAllDocuments(false); // Reset view when changing workspace
    const res = await fetch(
      `http://localhost:3002/api/documents/workspace/${workspace.id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const data = await res.json();
    if (res.ok) {
      setDocuments(data);
    }
  };

  const createWorkspace = async () => {
    if (!newWorkspaceName) {
      return;
    }
    const res = await fetch("http://localhost:3002/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: newWorkspaceName }),
    });
    if (res.ok) {
      setNewWorkspaceName("");
      fetchWorkspaces();
    }
  };

  const inviteMember = async () => {
    if (!inviteEmail || !selectedWorkspace) {
      return;
    }
    const res = await fetch(
      `http://localhost:3002/api/workspaces/${selectedWorkspace.id}/invite`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: inviteEmail, role: "EDITOR" }),
      },
    );
    if (res.ok) {
      setInviteEmail("");
      setStatusMessage({
        text: "Member invited successfully!",
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
  };

  const createDocument = async () => {
    if (!selectedWorkspace) {
      return;
    }
    const res = await fetch(
      `http://localhost:3002/api/documents/workspace/${selectedWorkspace.id}`,
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
        </div>

        {/* Main Content: Documents */}
        <div className="td-main-content">
          {selectedWorkspace ? (
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

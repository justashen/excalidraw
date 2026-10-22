import React, { useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { LockedIcon, CloseIcon } from "@excalidraw/excalidraw/components/icons";

import "./TeamsLoginModal.scss";
import { BACKEND_URL } from "../app_constants";

import {
  deriveKeysFromPassword,
  generateMasterDataKey,
  exportAndEncryptMasterKey,
  decryptAndImportMasterKey,
  setSessionMasterKey,
  generateAsymmetricKeyPair,
  exportPublicKey,
  exportAndEncryptPrivateKey,
  decryptAndImportPrivateKey,
  setSessionPrivateKey,
} from "@excalidraw/excalidraw/data/vault";

interface TeamsLoginModalProps {
  onClose: () => void;
}

export const TeamsLoginModal: React.FC<TeamsLoginModalProps> = ({
  onClose,
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ message: string; type: "error" | "success" } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setLoading(true);

    try {
      if (!isLogin && password.length < 8) {
        setStatus({
          message: "Password must be at least 8 characters long for secure encryption.",
          type: "error",
        });
        setLoading(false);
        return;
      }

      // 1. Fetch user's registered cryptographic salt if logging in
      let userSalt: string | undefined = undefined;
      if (isLogin) {
        try {
          const saltRes = await fetch(
            `${BACKEND_URL}/api/auth/salt?email=${encodeURIComponent(email)}`,
          );
          if (saltRes.ok) {
            const saltData = await saltRes.json();
            userSalt = saltData.salt || undefined;
          }
        } catch (e) {
          console.warn("Could not fetch remote salt, falling back to local derivation", e);
        }
      }

      // 2. Derive KEK and Auth Hash client-side from password using cryptographically secure random salt
      const { authHash, kek, saltHex } = await deriveKeysFromPassword(password, email, userSalt);

      let payload: Record<string, any> = {
        email,
        password: authHash,
        name: email.split("@")[0],
      };

      let generatedMasterKey: CryptoKey | null = null;
      let generatedKeyPair: CryptoKeyPair | null = null;
      if (!isLogin) {
        // Registration: generate 256-bit AES master key and ECDH keypair
        generatedMasterKey = await generateMasterDataKey();
        const encryptedMasterKey = await exportAndEncryptMasterKey(generatedMasterKey, kek);
        payload.encryptedMasterKey = encryptedMasterKey;
        payload.passwordSalt = saltHex;

        // Generate ECDH P-256 keypair for E2EE collaborative workspace key wrapping
        generatedKeyPair = await generateAsymmetricKeyPair();
        const pubKeyHex = await exportPublicKey(generatedKeyPair.publicKey);
        const encPrivKeyHex = await exportAndEncryptPrivateKey(generatedKeyPair.privateKey, generatedMasterKey);
        payload.publicKey = pubKeyHex;
        payload.encryptedPrivateKey = encPrivKeyHex;
      }

      const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem("team_jwt", data.token);

        // 2. Unwrap master data key and private key, cache in session memory
        if (isLogin) {
          let activeMasterKey: CryptoKey | null = null;
          if (data.user?.encryptedMasterKey) {
            try {
              activeMasterKey = await decryptAndImportMasterKey(data.user.encryptedMasterKey, kek);
              await setSessionMasterKey(activeMasterKey);
            } catch (err) {
              console.error("Failed to decrypt master key with credentials", err);
            }
          }

          if (data.user?.encryptedPrivateKey && activeMasterKey) {
            try {
              const privKey = await decryptAndImportPrivateKey(data.user.encryptedPrivateKey, activeMasterKey);
              await setSessionPrivateKey(privKey);
            } catch (privErr) {
              console.warn("Could not import private key from vault", privErr);
            }
          }
        } else {
          if (generatedMasterKey) {
            await setSessionMasterKey(generatedMasterKey);
          }
          if (generatedKeyPair) {
            await setSessionPrivateKey(generatedKeyPair.privateKey);
          }
        }

        setStatus({
          message: isLogin
            ? `Welcome back, ${data.user.name || "Explorer"}! E2EE Vault unlocked.`
            : "Account created & Zero-Knowledge Vault initialized! Logging you in...",
          type: "success",
        });
        setTimeout(() => {
          onClose();
          window.location.reload();
        }, 1000);
      } else {
        setStatus({
          message: data.error || "Authentication failed. Please check your credentials.",
          type: "error",
        });
      }
    } catch (err: any) {
      console.error("Login/Auth Error:", err);
      setStatus({
        message: err?.message ? `Authentication error: ${err.message}` : "Authentication error or failed to connect to backend.",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      onCloseRequest={onClose}
      title={false}
      className="TeamsLoginModal"
      size="small"
    >
      <button
        type="button"
        className="TeamsLoginModal__close"
        onClick={onClose}
        aria-label="Close"
      >
        {CloseIcon}
      </button>

      <div className="TeamsLoginModal__header">
        <div className="brand-icon-wrapper">
          {LockedIcon}
        </div>
        <h3>{isLogin ? "Sign In" : "Create Account"}</h3>
        <p>
          {isLogin
            ? "Sign in to access your shared workspaces, save diagrams to cloud, and upload PDF documents."
            : "Create your account to start syncing diagrams and collaborating with your team."}
        </p>
      </div>

      <form className="TeamsLoginModal__form" onSubmit={handleSubmit}>
        <div className="input-group">
          <label htmlFor="user-email">Email Address</label>
          <div className="input-wrapper">
            <span className="input-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </span>
            <input
              id="user-email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
        </div>

        <div className="input-group">
          <label htmlFor="user-password">Password</label>
          <div className="input-wrapper">
            <span className="input-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <input
              id="user-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </div>

        <button type="submit" className="submit-button" disabled={loading}>
          {loading ? (
            <span className="spinner" />
          ) : (
            isLogin ? "Sign In" : "Create Account"
          )}
        </button>
      </form>

      {status && (
        <div className={`TeamsLoginModal__alert TeamsLoginModal__alert--${status.type}`}>
          {status.type === "error" ? "⚠️ " : "✓ "}
          {status.message}
        </div>
      )}

      <div className="TeamsLoginModal__footer">
        {isLogin ? "Don't have an account yet?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setIsLogin(!isLogin);
            setStatus(null);
          }}
        >
          {isLogin ? "Sign up" : "Sign in"}
        </button>
      </div>
    </Dialog>
  );
};

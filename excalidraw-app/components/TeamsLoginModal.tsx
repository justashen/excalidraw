import React, { useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";

import "./TeamsLoginModal.scss";

interface TeamsLoginModalProps {
  onClose: () => void;
}

export const TeamsLoginModal: React.FC<TeamsLoginModalProps> = ({
  onClose,
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
    try {
      const res = await fetch(`http://localhost:3002${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: email.split("@")[0] }),
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem("team_jwt", data.token);
        setMessage(`Success! Welcome to Teams, ${data.user.name}`);
        setTimeout(() => onClose(), 2000);
      } else {
        setMessage(data.error || "Something went wrong.");
      }
    } catch (err) {
      setMessage("Failed to connect to backend.");
    }
  };

  return (
    <Dialog
      onCloseRequest={onClose}
      title={isLogin ? "Login to Teams" : "Create Teams Account"}
      className="TeamsLoginModal"
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "10px" }}
      >
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: "8px" }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ padding: "8px" }}
        />
        <button
          type="submit"
          style={{
            padding: "10px",
            cursor: "pointer",
            background: "#4e7ab5",
            color: "white",
            border: "none",
            borderRadius: "4px",
          }}
        >
          {isLogin ? "Login" : "Register"}
        </button>
      </form>
      {message && <p style={{ marginTop: "10px", color: "red" }}>{message}</p>}
      <p style={{ marginTop: "20px", fontSize: "0.9em" }}>
        {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            color: "#4e7ab5",
            cursor: "pointer",
            textDecoration: "underline",
            padding: 0,
          }}
          onClick={(e) => {
            e.preventDefault();
            setIsLogin(!isLogin);
          }}
        >
          {isLogin ? "Register here" : "Login here"}
        </button>
      </p>
    </Dialog>
  );
};

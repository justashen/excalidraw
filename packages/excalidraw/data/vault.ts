/**
 * Client-Side Cryptographic Vault for Zero-Knowledge E2EE
 * Uses standard Web Crypto API (PBKDF2 + AES-GCM)
 */

export const PBKDF2_ITERATIONS = 100000;
export const AES_KEY_BITS = 256;

// Convert buffer to hex string
export const bufferToHex = (buffer: ArrayBuffer): string => {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Convert hex string to Uint8Array
export const hexToBuffer = (hex: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes as Uint8Array<ArrayBuffer>;
};

/**
 * Derives the Key-Encryption-Key (KEK) and the server authentication hash from password & email.
 * - authHash is safe to send to server.
 * - kek never leaves browser memory.
 */
export const deriveKeysFromPassword = async (
  password: string,
  email: string,
  customSaltHex?: string,
): Promise<{ authHash: string; kek: CryptoKey; saltHex: string }> => {
  const encoder = new TextEncoder();
  const normalizedEmail = email.toLowerCase().trim();

  // If custom salt is provided, use it; otherwise generate a cryptographically secure random 16-byte salt
  let saltBytes: Uint8Array;
  let saltHex: string;

  if (customSaltHex) {
    saltBytes = hexToBuffer(customSaltHex);
    saltHex = customSaltHex;
  } else {
    saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
    saltHex = bufferToHex(saltBytes.buffer as ArrayBuffer);
  }

  // Combine user-specific random salt with normalized email for domain separation
  const kekSalt = new Uint8Array(saltBytes.length + encoder.encode(normalizedEmail).length);
  kekSalt.set(saltBytes);
  kekSalt.set(encoder.encode(normalizedEmail), saltBytes.length);

  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey", "deriveBits"],
  );

  // 1. Derive 256-bit KEK (Key Encryption Key) for decrypting master keys
  const kek = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: kekSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_BITS },
    true,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );

  // 2. Derive separate bits for server authentication (authHash) with separate domain salt
  const authSalt = encoder.encode(`auth-salt:${saltHex}:${normalizedEmail}`);
  const authBits = await window.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: authSalt,
      iterations: 10000,
      hash: "SHA-256",
    },
    baseKey,
    256,
  );

  const authHash = bufferToHex(authBits);
  return { authHash, kek, saltHex };
};

/**
 * Generate a new random Master Data Key (AES-GCM 256)
 */
export const generateMasterDataKey = async (): Promise<CryptoKey> => {
  return await window.crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: AES_KEY_BITS,
    },
    true,
    ["encrypt", "decrypt"],
  );
};

/**
 * Encrypt the Master Data Key with KEK (to store on server)
 */
export const exportAndEncryptMasterKey = async (
  masterKey: CryptoKey,
  kek: CryptoKey,
): Promise<string> => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wrappedKeyBuffer = await window.crypto.subtle.wrapKey(
    "raw",
    masterKey,
    kek,
    { name: "AES-GCM", iv },
  );

  // Format: ivHex:wrappedKeyHex
  return `${bufferToHex(iv.buffer)}:${bufferToHex(wrappedKeyBuffer)}`;
};

/**
 * Decrypt the Master Data Key with KEK (when logging in)
 */
export const decryptAndImportMasterKey = async (
  encryptedMasterKeyHex: string,
  kek: CryptoKey,
): Promise<CryptoKey> => {
  const parts = encryptedMasterKeyHex.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid encrypted master key format");
  }

  const iv = hexToBuffer(parts[0]);
  const wrappedKeyBytes = hexToBuffer(parts[1]);

  return await window.crypto.subtle.unwrapKey(
    "raw",
    wrappedKeyBytes as any,
    kek,
    { name: "AES-GCM", iv: iv as any },
    { name: "AES-GCM", length: AES_KEY_BITS },
    true, // Extractable so it can be cached in sessionStorage for page refreshes
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
};

/**
 * Encrypt arbitrary string (like document JSON payload) with the Master Data Key
 */
export const encryptString = async (
  plaintext: string,
  key: CryptoKey,
): Promise<string> => {
  const encoder = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(plaintext);

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  return `e2ee:${bufferToHex(iv.buffer)}:${bufferToHex(encryptedBuffer)}`;
};

/**
 * Decrypt arbitrary string (or return plaintext if not encrypted yet)
 */
export const decryptString = async (
  ciphertext: string,
  key: CryptoKey | null,
): Promise<string> => {
  if (!ciphertext) {
    return "";
  }

  // If not prefixed with "e2ee:", this is legacy unencrypted plaintext JSON
  if (!ciphertext.startsWith("e2ee:")) {
    if (typeof window !== "undefined" && (window as any).__DRAW_DEBUG__) {
      console.log("[Draw-Debug] Decrypt: Plaintext/legacy document detected, passing through.");
    }
    return ciphertext;
  }

  if (!key) {
    const errorMsg = "E2EE Vault is locked: Master/Workspace encryption key is missing.";
    console.warn(`[Draw-Debug] Decrypt Warning: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    const errorMsg = "Corrupted encrypted document payload (expected e2ee:iv:data).";
    console.error(`[Draw-Debug] Decrypt Error: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  try {
    const iv = hexToBuffer(parts[1]);
    const encryptedBytes = hexToBuffer(parts[2]);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as any },
      key,
      encryptedBytes as any,
    );

    const decoded = new TextDecoder().decode(decryptedBuffer);
    if (typeof window !== "undefined" && (window as any).__DRAW_DEBUG__) {
      console.log("[Draw-Debug] Decrypt: Successfully decrypted document payload.");
    }
    return decoded;
  } catch (err: any) {
    console.error("[Draw-Debug] Decrypt Failure:", err);
    throw new Error(`Failed to decrypt document payload: ${err.message || "Cipher integrity verification failed"}`);
  }
};

/**
 * Encrypt binary File or Blob (e.g. PDF attachments)
 */
export const encryptBinary = async (
  file: File | Blob,
  key: CryptoKey,
): Promise<{ encryptedBlob: Blob; ivHex: string }> => {
  const arrayBuffer = await file.arrayBuffer();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    arrayBuffer,
  );

  return {
    encryptedBlob: new Blob([encryptedBuffer], { type: "application/octet-stream" }),
    ivHex: bufferToHex(iv.buffer),
  };
};

/**
 * Decrypt binary ArrayBuffer back to readable Blob
 */
export const decryptBinary = async (
  encryptedBuffer: ArrayBuffer,
  ivHex: string,
  mimeType: string,
  key: CryptoKey,
): Promise<Blob> => {
  const iv = hexToBuffer(ivHex);
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    encryptedBuffer,
  );

  return new Blob([decryptedBuffer], { type: mimeType });
};

// Memory cache for active session master key and private key
let cachedSessionKey: CryptoKey | null = null;
let cachedSessionPrivateKey: CryptoKey | null = null;
const workspaceDekCache = new Map<string, CryptoKey>();

const SESSION_STORAGE_MASTER_KEY = "active_e2ee_vault_session";
const SESSION_STORAGE_PRIV_KEY = "active_e2ee_vault_priv";

export const clearSessionVaultKeys = (): void => {
  cachedSessionKey = null;
  cachedSessionPrivateKey = null;
  workspaceDekCache.clear();
  try {
    sessionStorage.removeItem(SESSION_STORAGE_MASTER_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_PRIV_KEY);
    sessionStorage.removeItem("active_e2ee_key");
  } catch (e) {
    // Ignore storage errors in restricted contexts
  }
};

export const setSessionMasterKey = async (key: CryptoKey | null): Promise<void> => {
  cachedSessionKey = key;
  try {
    if (key) {
      const raw = await window.crypto.subtle.exportKey("raw", key);
      sessionStorage.setItem(SESSION_STORAGE_MASTER_KEY, bufferToHex(raw));
    } else {
      sessionStorage.removeItem(SESSION_STORAGE_MASTER_KEY);
    }
  } catch (e) {
    // Ignore export/storage errors (e.g. if key is not extractable)
  }
};

export const getSessionMasterKey = async (): Promise<CryptoKey | null> => {
  if (cachedSessionKey) {
    return cachedSessionKey;
  }
  try {
    const hex = sessionStorage.getItem(SESSION_STORAGE_MASTER_KEY);
    if (hex) {
      const buffer = hexToBuffer(hex);
      cachedSessionKey = await window.crypto.subtle.importKey(
        "raw",
        buffer as any,
        { name: "AES-GCM", length: AES_KEY_BITS },
        true,
        ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      );
      return cachedSessionKey;
    }
  } catch (e) {
    console.warn("Failed to restore master key from session storage", e);
  }
  return null;
};

export const setSessionPrivateKey = async (key: CryptoKey | null): Promise<void> => {
  cachedSessionPrivateKey = key;
  try {
    if (key) {
      const pkcs8 = await window.crypto.subtle.exportKey("pkcs8", key);
      sessionStorage.setItem(SESSION_STORAGE_PRIV_KEY, bufferToHex(pkcs8));
    } else {
      sessionStorage.removeItem(SESSION_STORAGE_PRIV_KEY);
    }
  } catch (e) {
    // Ignore export/storage errors
  }
};

export const getSessionPrivateKey = async (): Promise<CryptoKey | null> => {
  if (cachedSessionPrivateKey) {
    return cachedSessionPrivateKey;
  }
  try {
    const hex = sessionStorage.getItem(SESSION_STORAGE_PRIV_KEY);
    if (hex) {
      const buffer = hexToBuffer(hex);
      cachedSessionPrivateKey = await window.crypto.subtle.importKey(
        "pkcs8",
        buffer as any,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"],
      );
      return cachedSessionPrivateKey;
    }
  } catch (e) {
    console.warn("Failed to restore private key from session storage", e);
  }
  return null;
};

/**
 * Generate an ECDH P-256 keypair for ECIES asymmetric wrapping of Workspace DEKs
 */
export const generateAsymmetricKeyPair = async (): Promise<CryptoKeyPair> => {
  return await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
};

export const exportPublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const spki = await window.crypto.subtle.exportKey("spki", publicKey);
  return bufferToHex(spki);
};

export const exportAndEncryptPrivateKey = async (
  privateKey: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> => {
  const pkcs8 = await window.crypto.subtle.exportKey("pkcs8", privateKey);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    pkcs8,
  );
  return `${bufferToHex(iv.buffer)}:${bufferToHex(encrypted)}`;
};

export const decryptAndImportPrivateKey = async (
  encryptedPrivateKeyHex: string,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> => {
  const parts = encryptedPrivateKeyHex.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid encrypted private key format");
  const iv = hexToBuffer(parts[0]);
  const encryptedBytes = hexToBuffer(parts[1]);
  const pkcs8 = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    wrappingKey,
    encryptedBytes as any,
  );
  return await window.crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    false, // Hardware/engine protected: private key cannot be exported by injected DOM scripts
    ["deriveKey", "deriveBits"],
  );
};

/**
 * Generate a 256-bit AES-GCM Workspace Data Encryption Key (DEK)
 */
export const generateWorkspaceDek = async (): Promise<CryptoKey> => {
  return await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: AES_KEY_BITS },
    true,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
};

/**
 * Wrap a Workspace DEK for the creator using their own Master Key
 */
export const wrapWorkspaceDekForSelf = async (
  dek: CryptoKey,
  masterKey: CryptoKey,
): Promise<string> => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await window.crypto.subtle.wrapKey(
    "raw",
    dek,
    masterKey,
    { name: "AES-GCM", iv },
  );
  return `master:${bufferToHex(iv.buffer)}:${bufferToHex(wrapped)}`;
};

/**
 * Wrap a Workspace DEK for a recipient using their ECDH public key (ECIES)
 */
export const wrapWorkspaceDekForRecipient = async (
  dek: CryptoKey,
  recipientPublicKeyHex: string,
): Promise<string> => {
  const recipientSpki = hexToBuffer(recipientPublicKeyHex);
  const recipientPubKey = await window.crypto.subtle.importKey(
    "spki",
    recipientSpki as any,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // Generate an ephemeral ECDH keypair
  const ephemeral = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );

  const sharedWrappingKey = await window.crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientPubKey },
    ephemeral.privateKey,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["wrapKey"],
  );

  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const wrappedDek = await window.crypto.subtle.wrapKey(
    "raw",
    dek,
    sharedWrappingKey,
    { name: "AES-GCM", iv },
  );

  const ephemeralSpki = await window.crypto.subtle.exportKey("spki", ephemeral.publicKey);
  return `ecies:${bufferToHex(ephemeralSpki)}:${bufferToHex(iv.buffer)}:${bufferToHex(wrappedDek)}`;
};

/**
 * Unwrap a Workspace DEK using either the user's Master Key or their ECDH private key
 */
export const unwrapWorkspaceDek = async (
  encryptedDekStr: string,
  masterKey: CryptoKey | null,
  userPrivateKey: CryptoKey | null,
): Promise<CryptoKey> => {
  if (!encryptedDekStr || typeof encryptedDekStr !== "string") {
    throw new Error("Invalid DEK payload provided");
  }

  if (encryptedDekStr.startsWith("master:")) {
    if (!masterKey) throw new Error("Master key required to unwrap workspace DEK");
    const parts = encryptedDekStr.split(":");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
      throw new Error("Malformed master-wrapped DEK envelope");
    }
    const iv = hexToBuffer(parts[1]);
    const wrappedBytes = hexToBuffer(parts[2]);
    return await window.crypto.subtle.unwrapKey(
      "raw",
      wrappedBytes as any,
      masterKey,
      { name: "AES-GCM", iv: iv as any },
      { name: "AES-GCM", length: AES_KEY_BITS },
      false, // Hardware/engine protected: key cannot be exported by injected DOM scripts
      ["encrypt", "decrypt"],
    );
  }

  if (encryptedDekStr.startsWith("ecies:")) {
    if (!userPrivateKey) throw new Error("User private key required to unwrap invited workspace DEK");
    const parts = encryptedDekStr.split(":");
    if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
      throw new Error("Malformed ECIES DEK envelope");
    }
    const ephemeralSpki = hexToBuffer(parts[1]);
    const iv = hexToBuffer(parts[2]);
    const wrappedBytes = hexToBuffer(parts[3]);

    const ephemeralPubKey = await window.crypto.subtle.importKey(
      "spki",
      ephemeralSpki as any,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );

    const sharedWrappingKey = await window.crypto.subtle.deriveKey(
      { name: "ECDH", public: ephemeralPubKey },
      userPrivateKey,
      { name: "AES-GCM", length: AES_KEY_BITS },
      false,
      ["unwrapKey"],
    );

    return await window.crypto.subtle.unwrapKey(
      "raw",
      wrappedBytes as any,
      sharedWrappingKey,
      { name: "AES-GCM", iv: iv as any },
      { name: "AES-GCM", length: AES_KEY_BITS },
      false, // Hardware/engine protected: key cannot be exported by injected DOM scripts
      ["encrypt", "decrypt"],
    );
  }

  // Fallback for simple legacy wrapped format (colon delimited iv:wrappedKey)
  if (masterKey) {
    const parts = encryptedDekStr.split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const iv = hexToBuffer(parts[0]);
      const wrappedBytes = hexToBuffer(parts[1]);
      return await window.crypto.subtle.unwrapKey(
        "raw",
        wrappedBytes as any,
        masterKey,
        { name: "AES-GCM", iv: iv as any },
        { name: "AES-GCM", length: AES_KEY_BITS },
        false, // Hardware/engine protected: key cannot be exported by injected DOM scripts
        ["encrypt", "decrypt"],
      );
    }
  }

  throw new Error("Cannot unwrap Workspace DEK: unrecognized format");
};

export const setCachedWorkspaceDek = (workspaceId: string, key: CryptoKey): void => {
  workspaceDekCache.set(workspaceId, key);
};

export const getCachedWorkspaceDek = (workspaceId: string): CryptoKey | null => {
  return workspaceDekCache.get(workspaceId) || null;
};

/**
 * Retrieve or fetch and unwrap the Workspace DEK for a given workspace
 */
export const getOrFetchWorkspaceDek = async (
  workspaceId: string,
  token?: string,
): Promise<CryptoKey | null> => {
  if (workspaceDekCache.has(workspaceId)) {
    return workspaceDekCache.get(workspaceId)!;
  }

  const jwt = token || localStorage.getItem("team_jwt");
  if (!jwt) return null;

  try {
    const backendUrl =
      (import.meta.env.VITE_APP_BACKEND_URL as string) ||
      (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
      "http://localhost:3002";
    const res = await fetch(`${backendUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/key`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.encryptedDek) return null;

    const masterKey = await getSessionMasterKey();
    const privateKey = await getSessionPrivateKey();
    const dek = await unwrapWorkspaceDek(data.encryptedDek, masterKey, privateKey);
    workspaceDekCache.set(workspaceId, dek);
    return dek;
  } catch (err) {
    console.error("Failed to fetch or unwrap workspace DEK", err);
    return null;
  }
};

/**
 * Returns the effective encryption key for active collaboration:
 * Resolves the Workspace DEK when operating in a workspace, falling back to masterKey.
 */
export const getActiveEncryptionKey = async (): Promise<CryptoKey | null> => {
  let activeWorkspaceId = localStorage.getItem("active_workspace_id");

  // If active_workspace_id is not set, try to infer it from active_cloud_doc or workspaces list
  if (!activeWorkspaceId) {
    const token = localStorage.getItem("team_jwt");
    const activeDocId = localStorage.getItem("active_cloud_doc");
    const backendUrl =
      (import.meta.env.VITE_APP_BACKEND_URL as string) ||
      (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
      "http://localhost:3002";

    if (token && activeDocId) {
      try {
        const res = await fetch(`${backendUrl}/api/documents/${encodeURIComponent(activeDocId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const doc = await res.json();
          if (doc.workspaceId) {
            activeWorkspaceId = doc.workspaceId;
            localStorage.setItem("active_workspace_id", doc.workspaceId);
          }
        }
      } catch (e) {
        // Ignore fallback resolution errors
      }
    }

    if (!activeWorkspaceId && token) {
      try {
        const res = await fetch(`${backendUrl}/api/workspaces`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length > 0 && list[0].id) {
            activeWorkspaceId = list[0].id;
            localStorage.setItem("active_workspace_id", list[0].id);
          }
        }
      } catch (e) {
        // Ignore fallback resolution errors
      }
    }
  }

  if (activeWorkspaceId) {
    const dek = await getOrFetchWorkspaceDek(activeWorkspaceId);
    if (dek) return dek;
  }
  return await getSessionMasterKey();
};

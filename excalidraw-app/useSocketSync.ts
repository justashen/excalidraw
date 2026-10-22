import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { reconcileElements } from "@excalidraw/excalidraw";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import { encryptString, decryptString, getActiveEncryptionKey } from "@excalidraw/excalidraw/data/vault";

export const useSocketSync = (excalidrawAPI: ExcalidrawImperativeAPI | null) => {
  const socketRef = useRef<Socket | null>(null);
  const roomIdRef = useRef<string | null>(null);

  const isUpdatingRef = useRef(false);

  useEffect(() => {
    let checkInterval: any;
    
    const connectToSocket = () => {
      const token = localStorage.getItem("team_jwt");
      const docId = localStorage.getItem("active_cloud_doc");
      
      if (token && docId && excalidrawAPI) {
        if (roomIdRef.current !== docId) {
          if (socketRef.current) {
            socketRef.current.disconnect();
          }

          roomIdRef.current = docId;
          const wsServerUrl =
            (import.meta.env.VITE_APP_WS_SERVER_URL as string) ||
            (import.meta.env.VITE_APP_BACKEND_URL as string) ||
            "http://localhost:3002";
          const socket = io(wsServerUrl, {
            auth: { token },
            extraHeaders: { Authorization: `Bearer ${token}` },
          });
          socketRef.current = socket;

          socket.on("connect", () => {
            socket.emit("join-room", docId);
          });

          socket.on("force-leave-room", ({ roomId, reason }: { roomId: string; reason: string }) => {
            if (roomId === roomIdRef.current) {
              console.warn("Kicked from live room by server:", reason);
              roomIdRef.current = null;
              socket.disconnect();
            }
          });

          socket.on("server-broadcast", async (roomId: string, packet: any) => {
            if (roomId === roomIdRef.current && excalidrawAPI) {
              try {
                // Strict Zero-Knowledge enforcement: reject unencrypted packets in collaborative sessions
                if (!packet || typeof packet.encryptedPayload !== "string" || !packet.encryptedPayload.startsWith("e2ee:")) {
                  console.warn("Rejected unauthenticated/unencrypted broadcast packet: strict E2EE enforced.");
                  return;
                }

                const encryptionKey = await getActiveEncryptionKey();
                if (!encryptionKey) {
                  console.error("Active encryption key missing; unable to securely decrypt incoming packet.");
                  return;
                }

                const decrypted = await decryptString(packet.encryptedPayload, encryptionKey);
                const data = JSON.parse(decrypted);

                if (data.type === "UPDATE_ELEMENTS" && Array.isArray(data.elements)) {
                  const currentElements = excalidrawAPI.getSceneElementsIncludingDeleted();
                  const reconciledElements = reconcileElements(
                    currentElements,
                    data.elements as any,
                    excalidrawAPI.getAppState()
                  );
                  isUpdatingRef.current = true;
                  excalidrawAPI.updateScene({ elements: reconciledElements as any });
                  setTimeout(() => { isUpdatingRef.current = false; }, 100);
                } else if (data.type === "UPDATE_POINTER" && data.pointer?.pointer) {
                  const currentAppState = excalidrawAPI.getAppState();
                  const collaborators = new Map(currentAppState.collaborators || []);
                  collaborators.set(data.pointer.socketId, {
                    pointer: data.pointer.pointer,
                    button: data.pointer.button,
                    username: "Team Member",
                    id: data.pointer.socketId,
                  } as any);
                  
                  excalidrawAPI.updateScene({ collaborators });
                }
              } catch (err) {
                console.error("Failed to decrypt or process real-time packet", err);
              }
            }
          });
        }
      } else {
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
          roomIdRef.current = null;
        }
      }
    };

    if (excalidrawAPI) {
      connectToSocket();
      checkInterval = setInterval(connectToSocket, 1000);
    }

    return () => {
      clearInterval(checkInterval);
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [excalidrawAPI]);

  const broadcastElements = async (elements: readonly OrderedExcalidrawElement[]) => {
    if (isUpdatingRef.current) return;
    if (socketRef.current && socketRef.current.connected && roomIdRef.current) {
      try {
        const encryptionKey = await getActiveEncryptionKey();
        if (!encryptionKey) {
          console.warn("Zero-Knowledge Vault: Suppressing unencrypted element broadcast because no encryption key is active.");
          return;
        }

        const rawJson = JSON.stringify({
          type: "UPDATE_ELEMENTS",
          elements: elements,
        });

        const encryptedPayload = await encryptString(rawJson, encryptionKey);
        socketRef.current.emit("client-broadcast", roomIdRef.current, {
          encryptedPayload,
        });
      } catch (err) {
        console.error("Failed to broadcast encrypted elements", err);
      }
    }
  };

  const lastPointerBroadcastRef = useRef<number>(0);
  const pendingPointerRef = useRef<any>(null);
  const pointerThrottleTimerRef = useRef<any>(null);

  const flushPointer = async () => {
    if (!pendingPointerRef.current || !socketRef.current?.connected || !roomIdRef.current) {
      return;
    }
    const pointer = pendingPointerRef.current;
    pendingPointerRef.current = null;
    lastPointerBroadcastRef.current = Date.now();

    try {
      const encryptionKey = await getActiveEncryptionKey();
      if (!encryptionKey) {
        return;
      }

      const rawJson = JSON.stringify({
        type: "UPDATE_POINTER",
        pointer: { ...pointer, socketId: socketRef.current.id },
      });

      const encryptedPayload = await encryptString(rawJson, encryptionKey);
      socketRef.current.emit("client-broadcast", roomIdRef.current, {
        encryptedPayload,
      });
    } catch (err) {
      console.error("Failed to broadcast encrypted pointer", err);
    }
  };

  const broadcastPointer = (pointer: any) => {
    pendingPointerRef.current = pointer;
    const now = Date.now();
    const elapsed = now - lastPointerBroadcastRef.current;
    const THROTTLE_INTERVAL_MS = 35; // ~28 FPS optimal for real-time cursor collaboration

    if (elapsed >= THROTTLE_INTERVAL_MS) {
      if (pointerThrottleTimerRef.current) {
        clearTimeout(pointerThrottleTimerRef.current);
        pointerThrottleTimerRef.current = null;
      }
      flushPointer();
    } else if (!pointerThrottleTimerRef.current) {
      pointerThrottleTimerRef.current = setTimeout(() => {
        pointerThrottleTimerRef.current = null;
        flushPointer();
      }, THROTTLE_INTERVAL_MS - elapsed);
    }
  };

  return { broadcastElements, broadcastPointer };
};

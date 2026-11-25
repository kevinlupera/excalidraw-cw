import { base64ToBytes, bytesToBase64 } from "../data/bytes";

type Listener = {
  cb: (...args: any[]) => void;
  once: boolean;
};

const collabWebSocketUrl = (roomId: string) => {
  const path = `/api/collab/${encodeURIComponent(roomId)}`;
  const configured = import.meta.env.VITE_APP_WS_SERVER_URL;
  if (!configured || configured === "same-origin") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
  }
  const base = new URL(configured);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${base.host}${path}`;
};

const bytesToArrayBuffer = (bytes: Uint8Array<ArrayBuffer>) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export class CollabSocket {
  id: string | undefined;
  private readonly ws: WebSocket;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(roomId: string) {
    this.ws = new WebSocket(collabWebSocketUrl(roomId));
    this.ws.addEventListener("message", this.onMessage);
    this.ws.addEventListener("error", () => {
      this.dispatch("connect_error");
    });
  }

  on(event: string, cb: (...args: any[]) => void) {
    this.addListener(event, cb, false);
  }

  once(event: string, cb: (...args: any[]) => void) {
    this.addListener(event, cb, true);
  }

  off(event: string, cb?: (...args: any[]) => void) {
    if (!cb) {
      this.listeners.delete(event);
      return;
    }
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    this.listeners.set(
      event,
      listeners.filter((listener) => listener.cb !== cb),
    );
  }

  emit(event: string, ...args: any[]) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (event === "join-room") {
      this.ws.send(JSON.stringify({ op: "join-room", roomId: args[0] }));
      return;
    }
    if (event === "server-broadcast" || event === "server-volatile-broadcast") {
      this.ws.send(
        JSON.stringify({
          op: event,
          roomId: args[0],
          data: bytesToBase64(args[1] as ArrayBuffer),
          iv: bytesToBase64(args[2] as Uint8Array),
        }),
      );
      return;
    }
    if (event === "user-follow") {
      this.ws.send(JSON.stringify({ op: "user-follow", payload: args[0] }));
    }
  }

  close() {
    this.ws.close();
  }

  private addListener(
    event: string,
    cb: (...args: any[]) => void,
    once: boolean,
  ) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push({ cb, once });
    this.listeners.set(event, listeners);
  }

  private dispatch(event: string, ...args: any[]) {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    this.listeners.set(
      event,
      listeners.filter((listener) => !listener.once),
    );
    for (const listener of listeners) {
      listener.cb(...args);
    }
  }

  private onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      return;
    }
    let message: {
      op?: string;
      socketId?: string;
      socketIds?: string[];
      data?: string;
      iv?: string;
      followedBy?: string[];
    };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (message.op) {
      case "init-room":
        this.id = message.socketId;
        this.dispatch("init-room");
        break;
      case "first-in-room":
        this.dispatch("first-in-room");
        break;
      case "new-user":
        this.dispatch("new-user", message.socketId);
        break;
      case "room-user-change":
        this.dispatch("room-user-change", message.socketIds);
        break;
      case "client-broadcast": {
        if (!message.data || !message.iv) {
          return;
        }
        const encrypted = base64ToBytes(message.data);
        this.dispatch(
          "client-broadcast",
          bytesToArrayBuffer(encrypted),
          base64ToBytes(message.iv),
        );
        break;
      }
      case "user-follow-room-change":
        this.dispatch("user-follow-room-change", message.followedBy);
        break;
      default:
        break;
    }
  };
}

export const createCollabSocket = (roomId: string) => new CollabSocket(roomId);

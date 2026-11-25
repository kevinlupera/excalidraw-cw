interface Env {
  ROOMS: DurableObjectNamespace;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
}

interface Session {
  id: string;
  joined: boolean;
  following: string | null;
}

type ClientMessage =
  | { op: "join-room"; roomId: string }
  | {
      op: "server-broadcast" | "server-volatile-broadcast";
      roomId: string;
      data: string;
      iv: string;
    }
  | {
      op: "user-follow";
      payload: {
        userToFollow: { socketId: string; username: string };
        action: "FOLLOW" | "UNFOLLOW";
      };
    };

type ServerMessage =
  | { op: "init-room"; socketId: string }
  | { op: "first-in-room" }
  | { op: "new-user"; socketId: string }
  | { op: "room-user-change"; socketIds: string[] }
  | { op: "client-broadcast"; data: string; iv: string }
  | { op: "user-follow-room-change"; followedBy: string[] }
  | { op: "broadcast-unfollow" };

const MAX_SCENE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SHARE_BYTES = 20 * 1024 * 1024;
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STORAGE_KEY = /^[A-Za-z0-9._/-]+$/;
const SHARE_ID = /^[a-f0-9]{32}$/;

const bareEtag = (value: string) =>
  value.trim().replace(/^W\//, "").replaceAll('"', "");

const readSession = (ws: WebSocket): Session | null => {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object") {
    return null;
  }
  const session = value as Partial<Session>;
  if (typeof session.id !== "string" || typeof session.joined !== "boolean") {
    return null;
  }
  return {
    id: session.id,
    joined: session.joined,
    following: typeof session.following === "string" ? session.following : null,
  };
};

const send = (ws: WebSocket, message: ServerMessage) => {
  ws.send(JSON.stringify(message));
};

const parseClientMessage = (raw: string): ClientMessage | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const message = value as { op?: unknown };
  if (message.op === "join-room") {
    const roomId = (value as { roomId?: unknown }).roomId;
    return typeof roomId === "string" ? { op: "join-room", roomId } : null;
  }
  if (
    message.op === "server-broadcast" ||
    message.op === "server-volatile-broadcast"
  ) {
    const relay = value as { roomId?: unknown; data?: unknown; iv?: unknown };
    if (
      typeof relay.roomId !== "string" ||
      typeof relay.data !== "string" ||
      typeof relay.iv !== "string"
    ) {
      return null;
    }
    return {
      op: message.op,
      roomId: relay.roomId,
      data: relay.data,
      iv: relay.iv,
    };
  }
  if (message.op === "user-follow") {
    const payload = (value as { payload?: unknown }).payload as
      | {
          action?: unknown;
          userToFollow?: { socketId?: unknown; username?: unknown };
        }
      | undefined;
    if (
      !payload ||
      (payload.action !== "FOLLOW" && payload.action !== "UNFOLLOW") ||
      typeof payload.userToFollow?.socketId !== "string" ||
      typeof payload.userToFollow?.username !== "string"
    ) {
      return null;
    }
    return {
      op: "user-follow",
      payload: {
        action: payload.action,
        userToFollow: {
          socketId: payload.userToFollow.socketId,
          username: payload.userToFollow.username,
        },
      },
    };
  }
  return null;
};

export class CollabRoom {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const session: Session = {
      id: crypto.randomUUID(),
      joined: false,
      following: null,
    };
    server.serializeAttachment(session);
    send(server, { op: "init-room", socketId: session.id });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") {
      return;
    }
    const message = parseClientMessage(raw);
    const session = readSession(ws);
    if (!message || !session) {
      return;
    }

    if (message.op === "join-room") {
      this.join(ws, session);
      return;
    }
    if (!session.joined) {
      return;
    }
    if (
      message.op === "server-broadcast" ||
      message.op === "server-volatile-broadcast"
    ) {
      this.relay(ws, message.data, message.iv);
      return;
    }
    if (message.op === "user-follow") {
      this.follow(ws, session, message.payload);
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.drop(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  private peers(except?: WebSocket) {
    const peers: { ws: WebSocket; session: Session }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) {
        continue;
      }
      const session = readSession(ws);
      if (session) {
        peers.push({ ws, session });
      }
    }
    return peers;
  }

  private join(ws: WebSocket, session: Session) {
    if (session.joined) {
      return;
    }
    session.joined = true;
    ws.serializeAttachment(session);

    const joined = this.peers().filter((peer) => peer.session.joined);
    if (joined.length <= 1) {
      send(ws, { op: "first-in-room" });
    } else {
      for (const peer of joined) {
        if (peer.ws !== ws) {
          send(peer.ws, { op: "new-user", socketId: session.id });
        }
      }
    }
    const socketIds = joined.map((peer) => peer.session.id);
    for (const peer of joined) {
      send(peer.ws, { op: "room-user-change", socketIds });
    }
  }

  private relay(sender: WebSocket, data: string, iv: string) {
    const message: ServerMessage = { op: "client-broadcast", data, iv };
    for (const peer of this.peers(sender)) {
      if (!peer.session.joined || peer.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      send(peer.ws, message);
    }
  }

  private follow(
    ws: WebSocket,
    session: Session,
    payload: Extract<ClientMessage, { op: "user-follow" }>["payload"],
  ) {
    const targetId = payload.userToFollow.socketId;
    if (payload.action === "FOLLOW") {
      session.following = targetId;
    } else if (session.following === targetId) {
      session.following = null;
    }
    ws.serializeAttachment(session);
    this.notifyFollowTarget(targetId);
  }

  private notifyFollowTarget(targetId: string, except?: WebSocket) {
    const peers = this.peers(except);
    const target = peers.find((peer) => peer.session.id === targetId);
    if (!target) {
      return;
    }
    const followedBy = peers
      .filter((peer) => peer.session.following === targetId)
      .map((peer) => peer.session.id);
    send(target.ws, { op: "user-follow-room-change", followedBy });
    if (followedBy.length === 0) {
      send(target.ws, { op: "broadcast-unfollow" });
    }
  }

  private drop(ws: WebSocket) {
    const session = readSession(ws);
    if (!session) {
      return;
    }
    const remaining = this.peers(ws).filter((peer) => peer.session.joined);
    if (session.joined && remaining.length > 0) {
      const socketIds = remaining.map((peer) => peer.session.id);
      for (const peer of remaining) {
        send(peer.ws, { op: "room-user-change", socketIds });
      }
    }
    if (session.following) {
      this.notifyFollowTarget(session.following, ws);
    }
  }
}

const json = (body: unknown, status = 200, extra?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

const tooLarge = () =>
  new Response("Scene is longer than 20971520 bytes", { status: 413 });

const readBody = async (request: Request, maxBytes: number) => {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    return null;
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return null;
  }
  return bytes;
};

const objectResponse = (
  object: R2ObjectBody,
  cacheControl: string,
): Response => {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", cacheControl);
  return new Response(object.body, { headers });
};

const putConditional = async (
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | string,
  request: Request,
  contentType: string,
) => {
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  const onlyIf: R2Conditional = {};
  if (ifNoneMatch === "*") {
    onlyIf.etagDoesNotMatch = "*";
  } else if (ifMatch) {
    onlyIf.etagMatches = bareEtag(ifMatch);
  }
  const stored = await bucket.put(key, body, {
    httpMetadata: { contentType },
    onlyIf: ifMatch || ifNoneMatch ? onlyIf : undefined,
  });
  if (!stored) {
    return new Response(null, { status: 412 });
  }
  return new Response(null, {
    status: 200,
    headers: { etag: stored.httpEtag },
  });
};

const handleScene = async (request: Request, env: Env, roomId: string) => {
  if (!ROOM_ID.test(roomId)) {
    return new Response("Invalid room", { status: 400 });
  }
  const key = `scenes/${roomId}`;
  if (request.method === "GET") {
    const object = await env.STORAGE.get(key);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }
    return objectResponse(object, "no-store");
  }
  if (request.method === "PUT") {
    const bytes = await readBody(request, MAX_SCENE_BYTES);
    if (!bytes) {
      return tooLarge();
    }
    return putConditional(env.STORAGE, key, bytes, request, "application/json");
  }
  return new Response("Method not allowed", { status: 405 });
};

const handleFile = async (request: Request, env: Env, pathname: string) => {
  const raw = decodeURIComponent(pathname.slice("/api/files/".length)).replace(
    /^\/+/,
    "",
  );
  if (!raw || raw.includes("..") || !STORAGE_KEY.test(raw)) {
    return new Response("Invalid file path", { status: 400 });
  }
  if (request.method === "GET") {
    const object = await env.STORAGE.get(raw);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }
    return objectResponse(object, "public, max-age=31536000");
  }
  if (request.method === "PUT") {
    const bytes = await readBody(request, MAX_FILE_BYTES);
    if (!bytes) {
      return new Response("File is longer than 8388608 bytes", { status: 413 });
    }
    await env.STORAGE.put(raw, bytes, {
      httpMetadata: {
        contentType: "application/octet-stream",
        cacheControl: "public, max-age=31536000",
      },
    });
    return new Response(null, { status: 200 });
  }
  return new Response("Method not allowed", { status: 405 });
};

const handleShare = async (request: Request, env: Env, url: URL) => {
  if (request.method === "POST" && url.pathname === "/api/v2/post") {
    const bytes = await readBody(request, MAX_SHARE_BYTES);
    if (!bytes) {
      return json({ error_class: "RequestTooLargeError" }, 413);
    }
    const idBytes = new Uint8Array(16);
    crypto.getRandomValues(idBytes);
    const id = [...idBytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await env.STORAGE.put(`shares/${id}`, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return json({ id });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/v2/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/v2/".length));
    if (!SHARE_ID.test(id)) {
      return new Response("Not found", { status: 404 });
    }
    const object = await env.STORAGE.get(`shares/${id}`);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }
    return objectResponse(object, "public, max-age=31536000");
  }

  return new Response("Not found", { status: 404 });
};

const handleCollab = async (request: Request, env: Env, url: URL) => {
  const roomId = decodeURIComponent(url.pathname.slice("/api/collab/".length));
  if (!ROOM_ID.test(roomId)) {
    return new Response("Invalid room", { status: 400 });
  }
  const id = env.ROOMS.idFromName(roomId);
  return env.ROOMS.get(id).fetch(request);
};

const cors = (response: Response, request: Request) => {
  const headers = new Headers(response.headers);
  headers.set(
    "access-control-allow-origin",
    request.headers.get("origin") || "*",
  );
  headers.set("access-control-expose-headers", "etag");
  headers.set(
    "access-control-allow-headers",
    "content-type, if-match, if-none-match",
  );
  headers.set("access-control-allow-methods", "GET, PUT, POST, OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/collab/")) {
      return handleCollab(request, env, url);
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return cors(new Response(null, { status: 204 }), request);
    }
    if (url.pathname.startsWith("/api/scenes/")) {
      return cors(
        await handleScene(
          request,
          env,
          decodeURIComponent(url.pathname.slice("/api/scenes/".length)),
        ),
        request,
      );
    }
    if (url.pathname.startsWith("/api/files/")) {
      return cors(await handleFile(request, env, url.pathname), request);
    }
    if (
      url.pathname === "/api/v2/post" ||
      url.pathname.startsWith("/api/v2/")
    ) {
      return cors(await handleShare(request, env, url), request);
    }
    if (url.pathname.startsWith("/api/")) {
      return cors(new Response("Not found", { status: 404 }), request);
    }
    return env.ASSETS.fetch(request);
  },
};

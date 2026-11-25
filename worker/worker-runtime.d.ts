interface DurableObjectId {}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(request: Request): Promise<Response>;
  };
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

interface R2HttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  onlyIf?: R2Conditional;
}

interface R2Object {
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket;
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

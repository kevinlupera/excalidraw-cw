import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { base64ToBytes, bytesToBase64 } from "./bytes";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

type StoredScene = {
  sceneVersion: number;
  ciphertext: string;
  iv: string;
};

const apiUrl = (path: string) => {
  const configured = import.meta.env.VITE_APP_WS_SERVER_URL;
  if (!configured || configured === "same-origin") {
    return path;
  }
  return new URL(path, configured).toString();
};

const sceneUrl = (roomId: string) =>
  apiUrl(`/api/scenes/${encodeURIComponent(roomId)}`);

const fileUrl = (prefix: string, id: string) => {
  const path = `${prefix}/${id}`.replace(/^\/+/, "");
  return apiUrl(
    `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: string; iv: string }> => {
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return {
    ciphertext: bytesToBase64(encryptedBuffer),
    iv: bytesToBase64(iv),
  };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    base64ToBytes(data.iv),
    base64ToBytes(data.ciphertext),
    roomKey,
  );
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class SceneVersionCache {
  private static cache = new WeakMap<object, number>();
  static get = (socket: object) => {
    return SceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: object,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);
    return SceneVersionCache.get(portal.socket) === sceneVersion;
  }
  return true;
};

const isStoredScene = (value: unknown): value is StoredScene => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const scene = value as Partial<StoredScene>;
  return (
    typeof scene.sceneVersion === "number" &&
    typeof scene.ciphertext === "string" &&
    typeof scene.iv === "string"
  );
};

const readScene = async (
  roomId: string,
): Promise<{ etag: string; scene: StoredScene } | null> => {
  const response = await fetch(sceneUrl(roomId));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load scene (${response.status})`);
  }
  const etag = response.headers.get("etag");
  const scene: unknown = await response.json();
  if (!etag || !isStoredScene(scene)) {
    throw new Error("Invalid scene");
  }
  return { etag, scene };
};

const createSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<StoredScene> => {
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion: getSceneVersion(elements),
    ciphertext,
    iv,
  };
};

const storedElementsFromScene = async (
  scene: StoredScene,
  roomKey: string,
  deleteInvisibleElements = false,
) =>
  getSyncableElements(
    restoreElements(await decryptElements(scene, roomKey), null, {
      deleteInvisibleElements,
    }),
  );

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      const response = await fetch(fileUrl(prefix, id), {
        method: "PUT",
        body: buffer as Uint8Array<ArrayBuffer>,
      });
      if (!response.ok) {
        erroredFiles.push(id);
        return;
      }
      savedFiles.push(id);
    }),
  );

  return { savedFiles, erroredFiles };
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToFirebase(portal, elements)) {
    return null;
  }

  let base = await readScene(roomId);
  for (let attempt = 0; attempt < 5; attempt++) {
    let elementsToStore = elements;
    if (base) {
      const previousElements = await storedElementsFromScene(
        base.scene,
        roomKey,
      );
      elementsToStore = getSyncableElements(
        reconcileElements(
          elements,
          previousElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    const storedScene = await createSceneDocument(elementsToStore, roomKey);
    const response = await fetch(sceneUrl(roomId), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(base ? { "if-match": base.etag } : { "if-none-match": "*" }),
      },
      body: JSON.stringify(storedScene),
    });

    if (response.status === 412) {
      base = await readScene(roomId);
      continue;
    }
    if (!response.ok) {
      throw new Error(await response.text());
    }

    const storedElements = await storedElementsFromScene(storedScene, roomKey);
    SceneVersionCache.set(socket, storedElements);
    return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
  }

  throw new Error("Failed to save scene");
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: object | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const stored = await readScene(roomId);
  if (!stored) {
    return null;
  }
  const elements = await storedElementsFromScene(stored.scene, roomKey, true);
  if (socket) {
    SceneVersionCache.set(socket, elements);
  }
  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(fileUrl(prefix, id));
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();
          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            { decryptionKey },
          );
          const dataURL = new TextDecoder().decode(data) as DataURL;
          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

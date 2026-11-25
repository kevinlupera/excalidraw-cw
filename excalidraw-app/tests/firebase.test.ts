import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import { saveFilesToFirebase } from "../data/firebase";

describe("saveFilesToFirebase", () => {
  it("rejects when storage is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      saveFilesToFirebase({
        prefix: "/files/shareLinks/id",
        files: [{ id: "file" as FileId, buffer: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8787";

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

const ink = async (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas.excalidraw__canvas.static");
    if (!(canvas instanceof HTMLCanvasElement)) {
      return -1;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return -1;
    }
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let marks = 0;
    for (let i = 0; i < data.length; i += 16) {
      const alpha = data[i + 3];
      if (alpha < 20) {
        continue;
      }
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) {
        marks += 1;
      }
    }
    return { marks, width, height };
  });

const browser = await chromium.launch();
const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const contextC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageA = await contextA.newPage();
const framesB = [];
const pageB = await contextB.newPage();
pageB.on("websocket", (ws) => {
  ws.on("framereceived", (frame) => {
    framesB.push(String(frame.payload));
  });
});

await pageA.goto(base, { waitUntil: "networkidle" });
await pageA.keyboard.press("r");
const canvas = pageA.locator("canvas").last();
const box = await canvas.boundingBox();
if (!box) {
  fail("no canvas on page A");
}
await pageA.mouse.move(box.x + 700, box.y + 240);
await pageA.mouse.down();
await pageA.mouse.move(box.x + 1100, box.y + 560, { steps: 12 });
await pageA.mouse.up();
await pageA.waitForTimeout(300);

await pageA.getByTitle("Live collaboration...").click();
await pageA.getByRole("button", { name: "Start session" }).click();
await pageA.waitForFunction(() => location.hash.startsWith("#room="));
const roomUrl = pageA.url();
const roomId = new URL(roomUrl).hash.slice("#room=".length).split(",")[0];
console.log(`page A started room ${roomId}`);

await pageB.goto(roomUrl, { waitUntil: "domcontentloaded" });
const started = Date.now();
while (
  !framesB.some((frame) => frame.includes("client-broadcast")) &&
  Date.now() - started < 15000
) {
  await pageB.waitForTimeout(200);
}

const sceneFrames = framesB.filter((frame) => frame.includes("client-broadcast"));
console.log(`page B websocket frames: ${framesB.length}, scene frames: ${sceneFrames.length}`);
if (sceneFrames.length === 0) {
  console.log(framesB.slice(0, 6).join("\n"));
  fail("page B did not receive a scene broadcast");
}
console.log(`page B received scene frame: ${sceneFrames[0].slice(0, 180)}...`);

const sceneUrl = `${base}/api/scenes/${roomId}`;
let loaded = null;
let loadedBody = "";
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  loaded = await fetch(sceneUrl);
  if (loaded.status === 200) {
    loadedBody = await loaded.text();
    break;
  }
  await pageA.waitForTimeout(200);
}
console.log(`GET ${sceneUrl} -> ${loaded.status} ${loadedBody.slice(0, 120)}`);
let stored;
try {
  stored = JSON.parse(loadedBody);
} catch {
  stored = null;
}
if (loaded.status !== 200 || typeof stored?.ciphertext !== "string" || typeof stored?.iv !== "string") {
  fail("page A did not save a scene");
}

await pageB.waitForTimeout(1000);
const empty = await contextC.newPage();
await empty.goto(base, { waitUntil: "networkidle" });
const emptyInk = await ink(empty);
const peerInk = await ink(pageB);
console.log(`canvas ink empty=${JSON.stringify(emptyInk)} peer=${JSON.stringify(peerInk)}`);
if (!peerInk || peerInk.marks < 0 || !emptyInk || peerInk.marks <= emptyInk.marks) {
  fail("peer canvas did not show the saved drawing");
}

await pageA.close();
await pageB.close();
await new Promise((resolve) => setTimeout(resolve, 500));
const contextD = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageD = await contextD.newPage();
const storageReads = [];
pageD.on("response", (response) => {
  if (response.url().includes(`/api/scenes/${roomId}`)) {
    storageReads.push(response.status());
  }
});
await pageD.goto(roomUrl, { waitUntil: "domcontentloaded" });
await pageD.waitForTimeout(2500);
const loadedInk = await ink(pageD);
console.log(
  `reloaded client storage reads=${JSON.stringify(storageReads)} ink=${JSON.stringify(loadedInk)}`,
);
if (!storageReads.includes(200) || !loadedInk || loadedInk.marks <= emptyInk.marks) {
  fail("a fresh client did not load the saved scene");
}

await browser.close();
console.log("PASS two app clients relayed a scene and storage round-tripped");

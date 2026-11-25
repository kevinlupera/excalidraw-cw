const base = process.argv[2] || "http://127.0.0.1:8787";

const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

const socketUrl = (roomId) => {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/collab/${roomId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const connect = (roomId) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl(roomId));
    const messages = [];
    const timeout = setTimeout(() => {
      reject(new Error(`timed out joining ${roomId}: ${JSON.stringify(messages)}`));
    }, 5000);
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket error"));
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      messages.push(message);
      if (message.op === "init-room") {
        ws.send(JSON.stringify({ op: "join-room", roomId }));
      }
      if (message.op === "first-in-room" || message.op === "room-user-change") {
        clearTimeout(timeout);
        resolve({ ws, messages });
      }
    });
  });

const waitFor = async (read, label) => {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const value = read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(`timed out waiting for ${label}`);
};

const roomId = `proof${Date.now().toString(16)}`;
const scene = {
  sceneVersion: 1,
  ciphertext: "Y2lwaGVydGV4dA==",
  iv: "aXY=",
};

const origin = await fetch(base);
console.log(`GET / -> ${origin.status}`);
if (origin.status !== 200) {
  fail(`expected the app shell, got ${origin.status}`);
}

const first = await connect(roomId);
console.log(`client A joined: ${JSON.stringify(first.messages)}`);
if (!first.messages.some((message) => message.op === "first-in-room")) {
  fail("first client was not first-in-room");
}

const secondMessages = [];
const second = await new Promise((resolve, reject) => {
  const ws = new WebSocket(socketUrl(roomId));
  const timeout = setTimeout(() => reject(new Error("client B timeout")), 5000);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    secondMessages.push(message);
    if (message.op === "init-room") {
      ws.send(JSON.stringify({ op: "join-room", roomId }));
    }
    if (
      message.op === "room-user-change" &&
      Array.isArray(message.socketIds) &&
      message.socketIds.length === 2
    ) {
      clearTimeout(timeout);
      resolve({ ws, messages: secondMessages });
    }
  });
});
console.log(`client B joined: ${JSON.stringify(second.messages)}`);

const relay = { data: "c2NlbmUtdXBkYXRl", iv: "aXYxMjM0NTY3ODkw" };
first.ws.send(
  JSON.stringify({
    op: "server-broadcast",
    roomId,
    data: relay.data,
    iv: relay.iv,
  }),
);

const received = await waitFor(
  () =>
    secondMessages.find(
      (message) =>
        message.op === "client-broadcast" &&
        message.data === relay.data &&
        message.iv === relay.iv,
    ),
  "client-broadcast",
);
console.log(`client B received scene update: ${JSON.stringify(received)}`);

const pointer = { data: "cG9pbnRlcg==", iv: "cG9pbnRlcml2MTI=" };
first.ws.send(
  JSON.stringify({
    op: "server-volatile-broadcast",
    roomId,
    data: pointer.data,
    iv: pointer.iv,
  }),
);
const volatileReceived = await waitFor(
  () =>
    secondMessages.find(
      (message) =>
        message.op === "client-broadcast" && message.data === pointer.data,
    ),
  "volatile client-broadcast",
);
console.log(
  `client B received volatile update: ${JSON.stringify(volatileReceived)}`,
);

const followerId = first.messages.find((message) => message.op === "init-room").socketId;
const targetId = second.messages.find((message) => message.op === "init-room").socketId;
first.ws.send(
  JSON.stringify({
    op: "user-follow",
    payload: {
      action: "FOLLOW",
      userToFollow: { socketId: targetId, username: "peer" },
    },
  }),
);
const follow = await waitFor(
  () =>
    secondMessages.find(
      (message) =>
        message.op === "user-follow-room-change" &&
        Array.isArray(message.followedBy) &&
        message.followedBy.includes(followerId),
    ),
  "user-follow-room-change",
);
console.log(`client B follow update: ${JSON.stringify(follow)}`);

const saved = await fetch(`${base}/api/scenes/${roomId}`, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    "if-none-match": "*",
  },
  body: JSON.stringify(scene),
});
console.log(
  `PUT /api/scenes/${roomId} -> ${saved.status} etag=${saved.headers.get("etag")}`,
);
if (saved.status !== 200) {
  fail(await saved.text());
}

const loaded = await fetch(`${base}/api/scenes/${roomId}`);
const loadedBody = await loaded.json();
console.log(`GET /api/scenes/${roomId} -> ${loaded.status} ${JSON.stringify(loadedBody)}`);
if (loaded.status !== 200 || loadedBody.ciphertext !== scene.ciphertext) {
  fail("saved scene did not load");
}

const conflict = await fetch(`${base}/api/scenes/${roomId}`, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    "if-match": '"stale-etag"',
  },
  body: JSON.stringify(scene),
});
console.log(`PUT stale If-Match -> ${conflict.status}`);
if (conflict.status !== 412) {
  fail("stale scene write was accepted");
}

const shareBody = new TextEncoder().encode("encrypted-share");
const posted = await fetch(`${base}/api/v2/post`, {
  method: "POST",
  body: shareBody,
});
const postedJson = await posted.json();
console.log(`POST /api/v2/post -> ${posted.status} ${JSON.stringify(postedJson)}`);
if (!postedJson.id) {
  fail("share link was not stored");
}
const shared = await fetch(`${base}/api/v2/${postedJson.id}`);
const sharedBytes = new Uint8Array(await shared.arrayBuffer());
console.log(
  `GET /api/v2/${postedJson.id} -> ${shared.status} ${sharedBytes.length} bytes`,
);
if (shared.status !== 200 || new TextDecoder().decode(sharedBytes) !== "encrypted-share") {
  fail("share link bytes did not round-trip");
}

const fileUrl = `${base}/api/files/files/rooms/${roomId}/image1`;
const uploaded = await fetch(fileUrl, {
  method: "PUT",
  body: new Uint8Array([1, 2, 3, 4]),
});
console.log(`PUT file -> ${uploaded.status}`);
const downloaded = new Uint8Array(await (await fetch(fileUrl)).arrayBuffer());
console.log(`GET file -> ${[...downloaded].join(",")}`);
if (downloaded.length !== 4 || downloaded[0] !== 1) {
  fail("file bytes did not round-trip");
}

first.ws.close();
second.ws.close();
console.log("PASS collab relay and scene storage");

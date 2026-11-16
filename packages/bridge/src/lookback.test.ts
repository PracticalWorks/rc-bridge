import { describe, expect, it } from "vitest";
import type { AttachmentDeps, RcMessage } from "./attachments.js";
import { fetchRecentImages, historyEndpoint, lookbackNote, recentImageMessages, type LookbackRequest } from "./lookback.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const limits = { maxBytes: 1000, maxImages: 4, maxDocumentBytes: 5000, maxDocumentChars: 50 };

const image = (id: string, over: Partial<RcMessage> = {}): RcMessage => ({
  _id: id,
  ts: ago(2),
  u: { _id: "ma1", username: "maria" },
  msg: "",
  file: { name: `${id}.png`, type: "image/png" },
  attachments: [{ title: `${id}.png`, title_link: `/file-upload/${id}/${id}.png`, image_type: "image/png" }],
  ...over,
});

const req = (over: Partial<LookbackRequest> = {}): LookbackRequest => ({
  roomId: "R1",
  roomType: "c",
  senderId: "ma1",
  senderName: "maria",
  messageId: "ASK",
  tmid: undefined,
  windowMs: 10 * 60_000,
  budget: 4,
  now: NOW,
  bot: { userId: "helper-id", username: "helper", faces: ["concierge"] },
  ...over,
});

describe("historyEndpoint", () => {
  it("picks the endpoint by room type, and has none for a DM or livechat", () => {
    expect(historyEndpoint("c")).toBe("channels.history");
    expect(historyEndpoint("p")).toBe("groups.history");
    expect(historyEndpoint("d")).toBeUndefined();
    expect(historyEndpoint("l")).toBeUndefined();
    expect(historyEndpoint(undefined)).toBeUndefined();
  });
});

describe("recentImageMessages", () => {
  it("keeps only the sender's own untagged images, in scope and in the window", () => {
    const history = [
      image("MINE"),
      image("SAM", { u: { _id: "sa1", username: "sam" } }),
      image("TAGGED", { msg: "@helper read this", mentions: [{ _id: "helper-id", username: "helper" }] }),
      image("CAPTIONED-FACE", { attachments: [{ title: "x.png", title_link: "/x", image_type: "image/png", description: "@concierge look" }] }),
      image("OLD", { ts: ago(30) }),
      image("THREADED", { tmid: "T1" }),
      image("ASK"),
      { _id: "TEXT", ts: ago(1), u: { _id: "ma1", username: "maria" }, msg: "no image here" },
      image("PDF", { attachments: [{ title: "a.pdf", title_link: "/a.pdf" }], file: { name: "a.pdf", type: "application/pdf" } }),
    ];
    expect(recentImageMessages(history, req()).map((m) => m._id)).toEqual(["MINE"]);
  });

  it("scopes a threaded ask to its own thread", () => {
    const history = [image("TOP"), image("IN-T1", { tmid: "T1" }), image("IN-T2", { tmid: "T2" })];
    expect(recentImageMessages(history, req({ tmid: "T1" })).map((m) => m._id)).toEqual(["IN-T1"]);
  });

  it("matches the sender by name when the webhook carried no id", () => {
    const history = [image("MINE"), image("SAM", { u: { username: "sam" } })];
    expect(recentImageMessages(history, req({ senderId: undefined })).map((m) => m._id)).toEqual(["MINE"]);
  });

  it("gives the budget to the newest, then returns them oldest first", () => {
    const history = [image("C", { ts: ago(1) }), image("B", { ts: ago(3) }), image("A", { ts: ago(5) })];
    expect(recentImageMessages(history, req({ budget: 2 })).map((m) => m._id)).toEqual(["B", "C"]);
  });
});

describe("fetchRecentImages", () => {
  function fakeRc(history: RcMessage[], status = 200) {
    const calls: string[] = [];
    const deps: AttachmentDeps = {
      rcUrl: "https://rc.example",
      headers: {},
      limits,
      get: async (url) => {
        calls.push(url);
        if (url.includes(".history?")) return new Response(JSON.stringify({ messages: history }), { status });
        const id = url.split("/").at(-1)!;
        return new Response(new Uint8Array(Buffer.from(`BYTES-${id}`)), { headers: { "content-type": "image/png" } });
      },
    };
    return { deps, calls };
  }

  it("makes ONE history call with the real params, then downloads the chosen images", async () => {
    const { deps, calls } = fakeRc([image("MINE"), image("SAM", { u: { _id: "sa1", username: "sam" } })]);
    const got = await fetchRecentImages(deps, req());
    expect(calls[0]).toBe(
      `https://rc.example/api/v1/channels.history?roomId=R1&oldest=${encodeURIComponent(ago(10))}&count=50`,
    );
    expect(calls.filter((c) => c.includes(".history?"))).toHaveLength(1);
    expect(got?.images.map((i) => i.dataUrl)).toEqual([`data:image/png;base64,${Buffer.from("BYTES-MINE.png").toString("base64")}`]);
  });

  it("asks channels.history for thread replies explicitly when the lookback is in a thread", async () => {
    const { deps, calls } = fakeRc([]);
    await fetchRecentImages(deps, req({ tmid: "T1" }));
    expect(new URL(calls[0]!).searchParams.get("showThreadMessages")).toBe("true");
    await fetchRecentImages(deps, req({ tmid: "T1", roomType: "p" }));
    expect(new URL(calls[1]!).searchParams.has("showThreadMessages")).toBe(false);
  });

  it("reads a private group through groups.history", async () => {
    const { deps, calls } = fakeRc([]);
    await fetchRecentImages(deps, req({ roomType: "p" }));
    expect(calls[0]).toContain("/api/v1/groups.history?");
  });

  it("makes no call at all for a DM, an unknown room type, a spent budget or a zero window", async () => {
    const { deps, calls } = fakeRc([image("MINE")]);
    expect(await fetchRecentImages(deps, req({ roomType: "d" }))).toBeUndefined();
    expect(await fetchRecentImages(deps, req({ roomType: undefined }))).toBeUndefined();
    expect(await fetchRecentImages(deps, req({ budget: 0 }))).toBeUndefined();
    expect(await fetchRecentImages(deps, req({ windowMs: 0 }))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("degrades to undefined when RC refuses the history read", async () => {
    const { deps } = fakeRc([], 403);
    expect(await fetchRecentImages(deps, req())).toBeUndefined();
  });
});

describe("lookbackNote", () => {
  it("tells the agent the images came from the sender's recent messages, not this one", () => {
    expect(lookbackNote(1, 10 * 60_000)).toBe(
      "(The attached image is from your recent messages here, posted in the last 10 min without tagging me — not from this message.)",
    );
    expect(lookbackNote(2, 10 * 60_000)).toContain("The 2 attached images are from your recent messages here");
  });
});

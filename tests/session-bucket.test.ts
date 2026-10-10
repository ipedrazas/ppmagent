import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ObjectWriter, SessionBucket } from "../src/session/bucket.ts";
import { newSession, SessionStore } from "../src/session/store.ts";

/** In-memory bucket; `gate` holds writes until released, to exercise coalescing. */
class FakeBucket implements ObjectWriter {
  objects = new Map<string, string>();
  writes: string[] = [];
  fail = false;
  gate: Promise<void> | null = null;

  async write(key: string, body: string): Promise<unknown> {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("bucket down");
    this.writes.push(key);
    this.objects.set(key, body);
    return body.length;
  }
}

const dir = mkdtempSync(join(import.meta.dir, ".sessbucket-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("SessionBucket", () => {
  test("uploads under the prefix as <sessionId>.json", async () => {
    const fake = new FakeBucket();
    const bucket = new SessionBucket(fake, "ppmagent/");
    bucket.put("abc", "{}");
    await bucket.flush();
    expect([...fake.objects.keys()]).toEqual(["ppmagent/abc.json"]);
  });

  test("saves during an in-flight upload coalesce, and the last one wins", async () => {
    const fake = new FakeBucket();
    let release = () => {};
    fake.gate = new Promise((r) => {
      release = r;
    });
    const bucket = new SessionBucket(fake, "");
    bucket.put("s", "v1");
    bucket.put("s", "v2");
    bucket.put("s", "v3");
    release();
    await bucket.flush();
    // v1 was already being written; v2 was superseded by v3 before its turn.
    expect(fake.writes).toEqual(["s.json", "s.json"]);
    expect(fake.objects.get("s.json")).toBe("v3");
  });

  test("a failed upload is swallowed", async () => {
    const fake = new FakeBucket();
    fake.fail = true;
    const bucket = new SessionBucket(fake, "");
    bucket.put("s", "{}");
    await bucket.flush();
    expect(fake.objects.size).toBe(0);
  });
});

describe("SessionStore with a bucket mirror", () => {
  test("uploads the sanitized file it writes, and keeps it after the session is deleted", async () => {
    const fake = new FakeBucket();
    const bucket = new SessionBucket(fake, "ppmagent/");
    const redact = (v: unknown) =>
      JSON.parse(JSON.stringify(v).replaceAll("hunter2", "[REDACTED]"));
    const store = new SessionStore(join(dir, "mirror", "session.json"), redact, bucket);

    const state = newSession("secretive");
    state.activeProject = "hunter2";
    store.save(state);
    await bucket.flush();

    const key = `ppmagent/${state.sessionId}.json`;
    const uploaded = JSON.parse(fake.objects.get(key) ?? "null");
    expect(uploaded.sessionId).toBe(state.sessionId);
    expect(uploaded.activeProject).toBe("[REDACTED]");
    expect(Array.isArray(uploaded.messages)).toBe(true);

    expect(store.delete(state.sessionId)).toBe(true);
    await bucket.flush();
    expect(fake.objects.has(key)).toBe(true);
  });
});

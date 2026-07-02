import { describe, expect, test } from "bun:test";
import { ConfirmationStore, isApproval, isRejection } from "../src/tools/confirmation.ts";

describe("ConfirmationStore", () => {
  test("starts empty", () => {
    const store = new ConfirmationStore();
    expect(store.get()).toBeNull();
    expect(store.hasPending()).toBe(false);
    expect(store.isExpired()).toBe(false);
  });

  test("set stores a confirmation with a description and executor", () => {
    const store = new ConfirmationStore();
    const exec = async () => "done";
    store.set("Do something risky", exec);
    const pending = store.get();
    expect(pending).not.toBeNull();
    expect(pending?.description).toBe("Do something risky");
    expect(pending?.execute).toBe(exec);
    expect(store.hasPending()).toBe(true);
  });

  test("set replaces any existing pending confirmation", () => {
    const store = new ConfirmationStore();
    store.set("First action", async () => "first");
    store.set("Second action", async () => "second");
    expect(store.get()?.description).toBe("Second action");
  });

  test("clear removes the pending confirmation", () => {
    const store = new ConfirmationStore();
    store.set("Something", async () => "result");
    store.clear();
    expect(store.get()).toBeNull();
    expect(store.hasPending()).toBe(false);
  });

  test("isExpired returns false for a freshly set confirmation", () => {
    const store = new ConfirmationStore();
    store.set("Something", async () => "result");
    expect(store.isExpired()).toBe(false);
  });

  test("execute resolves with the stored action result", async () => {
    const store = new ConfirmationStore();
    store.set("Deploy to prod", async () => "Deployed!");
    const pending = store.get();
    expect(await pending?.execute()).toBe("Deployed!");
  });
});

describe("isApproval", () => {
  for (const word of ["yes", "YES", "Yes", "y", "Y", "approve", "Approve", "ok", "OK", "confirm"]) {
    test(`recognizes '${word}'`, () => {
      expect(isApproval(word)).toBe(true);
    });
  }

  test("matches 'yes' with trailing text", () => {
    expect(isApproval("yes please")).toBe(true);
  });

  for (const word of ["no", "nope", "yeah", "yep", "yessir", "maybe"]) {
    test(`rejects '${word}'`, () => {
      expect(isApproval(word)).toBe(false);
    });
  }

  test("matches case-insensitively", () => {
    expect(isApproval("YES")).toBe(true);
    expect(isApproval("Approve")).toBe(true);
  });
});

describe("isRejection", () => {
  for (const word of ["no", "NO", "No", "n", "N", "cancel", "Cancel", "reject", "abort"]) {
    test(`recognizes '${word}'`, () => {
      expect(isRejection(word)).toBe(true);
    });
  }

  test("matches 'no' with trailing text", () => {
    expect(isRejection("no thanks")).toBe(true);
  });

  for (const word of ["yes", "nope", "never", "not now"]) {
    test(`rejects '${word}'`, () => {
      expect(isRejection(word)).toBe(false);
    });
  }

  test("matches case-insensitively", () => {
    expect(isRejection("NO")).toBe(true);
    expect(isRejection("Cancel")).toBe(true);
  });
});

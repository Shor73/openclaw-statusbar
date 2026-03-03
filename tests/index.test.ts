import { describe, it, expect, afterEach } from "vitest";
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";

/**
 * Tests for index.ts logic — pure functions extracted and tested directly.
 * The StatusbarRuntime class has heavy OpenClaw dependencies, so we test
 * the core logic functions independently.
 */

// --- acquireLock / releaseLock (replicated logic from StatusbarRuntime) ---

function lockPath(chatId: string | number): string {
  return `/tmp/test-statusbar-lock-${chatId}`;
}

function acquireLock(chatId: string | number): boolean {
  const lockFile = lockPath(chatId);
  const now = Date.now();
  try {
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, now.toString(), "utf8");
    closeSync(fd);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
    try {
      const content = readFileSync(lockFile, "utf8");
      const ts = parseInt(content, 10);
      if (isNaN(ts) || now - ts >= 90_000) {
        writeFileSync(lockFile, now.toString(), "utf8");
        return true;
      }
    } catch { return false; }
    return false;
  }
}

function releaseLock(chatId: string | number): void {
  try { unlinkSync(lockPath(chatId)); } catch { /* ignore */ }
}

// --- resolveRuntimeSessionKey (replicated logic) ---

function resolveRuntimeSessionKey(target: { chatId: string; threadId: number | null }): string {
  return `chat|${target.chatId}|${target.threadId ?? "main"}`;
}

// --- transitionPhase (replicated core logic) ---

type Phase = "idle" | "queued" | "running" | "thinking" | "tool" | "sending" | "done" | "error";

function transitionPhase(
  session: { phase: Phase; endedAtMs: number | null; dirtyCount: number },
  newPhase: Phase,
): { releasedLock: boolean } {
  if (session.phase === newPhase && newPhase !== "tool") return { releasedLock: false };
  session.phase = newPhase;
  session.dirtyCount += 1;
  let releasedLock = false;
  if (newPhase === "done" || newPhase === "error") {
    session.endedAtMs = Date.now();
    releasedLock = true;
  }
  return { releasedLock };
}

// --- Cleanup helpers ---

const lockFiles: string[] = [];

afterEach(() => {
  for (const f of lockFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  lockFiles.length = 0;
});

// --- Tests ---

describe("acquireLock / releaseLock", () => {
  const chatId = `test-${Date.now()}`;

  afterEach(() => {
    releaseLock(chatId);
  });

  it("acquires lock on first call", () => {
    lockFiles.push(lockPath(chatId));
    expect(acquireLock(chatId)).toBe(true);
    expect(existsSync(lockPath(chatId))).toBe(true);
  });

  it("fails to acquire lock when already held", () => {
    lockFiles.push(lockPath(chatId));
    expect(acquireLock(chatId)).toBe(true);
    expect(acquireLock(chatId)).toBe(false);
  });

  it("releases lock and allows re-acquire", () => {
    lockFiles.push(lockPath(chatId));
    expect(acquireLock(chatId)).toBe(true);
    releaseLock(chatId);
    expect(existsSync(lockPath(chatId))).toBe(false);
    expect(acquireLock(chatId)).toBe(true);
  });

  it("acquires stale lock (>90s old)", () => {
    const file = lockPath(chatId);
    lockFiles.push(file);
    // Write a timestamp 100s in the past
    const fd = openSync(file, "w");
    writeFileSync(fd, (Date.now() - 100_000).toString(), "utf8");
    closeSync(fd);
    expect(acquireLock(chatId)).toBe(true);
  });

  it("does not acquire fresh lock held by another", () => {
    const file = lockPath(chatId);
    lockFiles.push(file);
    const fd = openSync(file, "w");
    writeFileSync(fd, Date.now().toString(), "utf8");
    closeSync(fd);
    expect(acquireLock(chatId)).toBe(false);
  });

  it("releaseLock is idempotent", () => {
    releaseLock("nonexistent-chat-id");
    // Should not throw
  });
});

describe("resolveRuntimeSessionKey", () => {
  it("formats with chatId and main for null threadId", () => {
    const key = resolveRuntimeSessionKey({ chatId: "-100123", threadId: null });
    expect(key).toBe("chat|-100123|main");
  });

  it("formats with chatId and threadId", () => {
    const key = resolveRuntimeSessionKey({ chatId: "-100456", threadId: 789 });
    expect(key).toBe("chat|-100456|789");
  });

  it("uses pipe separator to avoid ambiguity", () => {
    const key = resolveRuntimeSessionKey({ chatId: "abc:def", threadId: null });
    expect(key).toBe("chat|abc:def|main");
    expect(key.split("|").length).toBe(3);
  });
});

describe("transitionPhase", () => {
  function makeSession(phase: Phase = "idle") {
    return { phase, endedAtMs: null as number | null, dirtyCount: 0 };
  }

  it("sets new phase", () => {
    const s = makeSession("idle");
    transitionPhase(s, "running");
    expect(s.phase).toBe("running");
    expect(s.dirtyCount).toBe(1);
  });

  it("skips no-op transition (same phase)", () => {
    const s = makeSession("running");
    const result = transitionPhase(s, "running");
    expect(s.dirtyCount).toBe(0);
    expect(result.releasedLock).toBe(false);
  });

  it("allows tool→tool transition (not skipped)", () => {
    const s = makeSession("tool");
    transitionPhase(s, "tool");
    expect(s.dirtyCount).toBe(1);
  });

  it("releases lock on done", () => {
    const s = makeSession("running");
    const result = transitionPhase(s, "done");
    expect(result.releasedLock).toBe(true);
    expect(s.endedAtMs).not.toBeNull();
  });

  it("releases lock on error", () => {
    const s = makeSession("running");
    const result = transitionPhase(s, "error");
    expect(result.releasedLock).toBe(true);
    expect(s.endedAtMs).not.toBeNull();
  });

  it("does NOT release lock on queued", () => {
    const s = makeSession("idle");
    const result = transitionPhase(s, "queued");
    expect(result.releasedLock).toBe(false);
  });

  it("does NOT release lock on idle", () => {
    const s = makeSession("running");
    const result = transitionPhase(s, "idle");
    expect(result.releasedLock).toBe(false);
  });

  it("does NOT release lock on running", () => {
    const s = makeSession("queued");
    const result = transitionPhase(s, "running");
    expect(result.releasedLock).toBe(false);
  });

  it("marks dirty on every valid transition", () => {
    const s = makeSession("idle");
    transitionPhase(s, "queued");
    transitionPhase(s, "running");
    transitionPhase(s, "tool");
    transitionPhase(s, "done");
    expect(s.dirtyCount).toBe(4);
  });
});

describe("lifecycle flow simulation", () => {
  it("simulates idle → queued → running → tool → running → done", () => {
    const s = { phase: "idle" as Phase, endedAtMs: null as number | null, dirtyCount: 0 };

    transitionPhase(s, "queued");
    expect(s.phase).toBe("queued");

    transitionPhase(s, "running");
    expect(s.phase).toBe("running");

    transitionPhase(s, "tool");
    expect(s.phase).toBe("tool");

    transitionPhase(s, "running");
    expect(s.phase).toBe("running");

    transitionPhase(s, "done");
    expect(s.phase).toBe("done");
    expect(s.endedAtMs).not.toBeNull();
    expect(s.dirtyCount).toBe(5);
  });

  it("simulates error path", () => {
    const s = { phase: "idle" as Phase, endedAtMs: null as number | null, dirtyCount: 0 };
    transitionPhase(s, "running");
    transitionPhase(s, "error");
    expect(s.phase).toBe("error");
    expect(s.endedAtMs).not.toBeNull();
  });
});

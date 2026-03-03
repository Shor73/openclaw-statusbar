import { describe, it, expect } from "vitest";
import { renderStatusText, renderStatusButtons } from "../src/render.js";
import { createMockSession, createMockPrefs } from "./mocks.js";

// We need to test shortModel — it's not exported, so we test via renderStatusText with detailed mode
// For direct testing, we'll use a workaround by importing the module and testing through renderDetailed

describe("shortModel (via renderStatusText detailed done phase)", () => {
  const prefs = createMockPrefs({ mode: "detailed" });

  function getModelFromRender(model: string): string {
    // Use "done" phase because model tag is only shown in done/error
    const session = createMockSession({
      phase: "done",
      model,
      startedAtMs: Date.now() - 30000,
      endedAtMs: Date.now(),
    });
    return renderStatusText(session, prefs);
  }

  it("renders opus-4.6", () => {
    expect(getModelFromRender("anthropic/claude-opus-4-6")).toContain("opus-4");
  });

  it("renders sonnet-4.6", () => {
    expect(getModelFromRender("anthropic/claude-sonnet-4-6")).toContain("sonnet-4");
  });

  it("renders haiku", () => {
    expect(getModelFromRender("anthropic/claude-haiku-3")).toContain("haiku-3");
  });

  it("renders glm-5", () => {
    expect(getModelFromRender("zai/glm-5")).toContain("glm-5");
  });

  it("renders glm-4.7", () => {
    expect(getModelFromRender("zai/glm-4.7-flash")).toContain("glm-4.7");
  });

  it("renders gpt-5", () => {
    expect(getModelFromRender("openai/gpt-5")).toContain("gpt-5");
  });

  it("renders llama", () => {
    expect(getModelFromRender("meta/llama-3.1-70b")).toContain("llama-3.1");
  });

  it("renders minimax", () => {
    expect(getModelFromRender("minimax/minimax-01")).toContain("minimax");
  });

  it("renders deepseek", () => {
    expect(getModelFromRender("deepseek/deepseek-chat")).toContain("deepseek");
  });

  it("renders unknown model as fallback", () => {
    const text = getModelFromRender("some-provider/custom-model-v2");
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("renderStatusText", () => {
  describe("compact/minimal mode", () => {
    const prefs = createMockPrefs({ mode: "minimal" });

    it("renders idle", () => {
      const session = createMockSession({ phase: "idle" });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("idle");
    });

    it("renders running with time", () => {
      const session = createMockSession({ phase: "running", startedAtMs: Date.now() - 15000 });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("thinking");
      expect(text).toContain("│");
    });

    it("renders tool with name", () => {
      const session = createMockSession({ phase: "tool", toolName: "exec" });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("exec");
    });

    it("renders done", () => {
      const session = createMockSession({
        phase: "done",
        startedAtMs: Date.now() - 31000,
        endedAtMs: Date.now(),
      });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("done");
    });
  });

  describe("normal mode", () => {
    const prefs = createMockPrefs({ mode: "normal" });

    it("renders with progress bar when running", () => {
      const session = createMockSession({
        phase: "running",
        startedAtMs: Date.now() - 10000,
        currentRunSteps: 2,
        predictedSteps: 5,
      });
      const text = renderStatusText(session, prefs);
      expect(text).toMatch(/[█░]/);
      expect(text).toContain("%");
    });

    it("renders queued", () => {
      const session = createMockSession({ phase: "queued" });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("coda");
      expect(text).toContain("░");
    });
  });

  describe("detailed mode", () => {
    const prefs = createMockPrefs({ mode: "detailed" });

    it("renders with model tag on done", () => {
      const session = createMockSession({
        phase: "done",
        model: "anthropic/claude-opus-4-6",
        startedAtMs: Date.now() - 15000,
        endedAtMs: Date.now(),
      });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("opus");
    });

    it("renders tool counter", () => {
      const session = createMockSession({
        phase: "tool",
        toolName: "exec",
        model: "test",
        currentRunSteps: 3,
        predictedSteps: 8,
        startedAtMs: Date.now() - 10000,
      });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("3/8▸");
    });

    it("renders tokens when available", () => {
      const session = createMockSession({
        phase: "done",
        model: "test",
        usageInput: 1500,
        usageOutput: 340,
        startedAtMs: Date.now() - 30000,
        endedAtMs: Date.now(),
      });
      const text = renderStatusText(session, prefs);
      expect(text).toContain("1.5k↑");
      expect(text).toContain("340↓");
    });
  });
});

describe("formatElapsed (via render)", () => {
  const prefs = createMockPrefs({ mode: "minimal" });

  it("formats <60s as MM:SS", () => {
    const session = createMockSession({
      phase: "running",
      startedAtMs: Date.now() - 45000,
    });
    const text = renderStatusText(session, prefs);
    expect(text).toMatch(/00:4[45]/);
  });

  it("formats >60s as MM:SS", () => {
    const session = createMockSession({
      phase: "running",
      startedAtMs: Date.now() - 125000,
    });
    const text = renderStatusText(session, prefs);
    expect(text).toMatch(/02:0[45]/);
  });

  it("formats >3600s as H:MM:SS", () => {
    const session = createMockSession({
      phase: "running",
      startedAtMs: Date.now() - 3665000,
    });
    const text = renderStatusText(session, prefs);
    expect(text).toMatch(/1:01:0[45]/);
  });
});

describe("renderStatusButtons", () => {
  it("returns active buttons during running", () => {
    const session = createMockSession({ phase: "running" });
    const prefs = createMockPrefs({ buttonsEnabled: true });
    const buttons = renderStatusButtons(session, prefs);
    expect(buttons).toBeDefined();
    expect(buttons!.length).toBeGreaterThan(0);
  });

  it("returns undefined when buttons disabled", () => {
    const session = createMockSession({ phase: "running" });
    const prefs = createMockPrefs({ buttonsEnabled: false });
    const buttons = renderStatusButtons(session, prefs);
    expect(buttons).toBeUndefined();
  });

  it("returns done buttons on done phase", () => {
    const session = createMockSession({ phase: "done" });
    const prefs = createMockPrefs({ buttonsEnabled: true });
    const buttons = renderStatusButtons(session, prefs);
    expect(buttons).toBeDefined();
    const allCallbacks = buttons!.flat().map(b => b.callback_data);
    expect(allCallbacks).toContain("/sbreset");
  });
});

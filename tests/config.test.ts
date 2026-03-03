import { describe, it, expect } from "vitest";
import { normalizePluginConfig } from "../src/config.js";

describe("normalizePluginConfig", () => {
  it("returns defaults for empty input", () => {
    const config = normalizePluginConfig({});
    expect(config.enabledByDefault).toBe(false);
    expect(config.defaultMode).toBe("normal");
    expect(config.defaultLayout).toBe("tiny1");
    expect(config.defaultProgressMode).toBe("predictive");
    expect(config.throttleMs).toBe(4000);
    expect(config.minThrottleMs).toBe(2500);
    expect(config.liveTickMs).toBe(2500);
    expect(config.maxRetriesEdit).toBe(0);
    expect(config.maxRetriesSend).toBe(4);
    expect(config.autoHideSeconds).toBe(0);
    expect(config.showInlineControls).toBe(false);
    expect(config.newMessagePerRun).toBe(true);
  });

  it("returns defaults for null input", () => {
    const config = normalizePluginConfig(null);
    expect(config.defaultMode).toBe("normal");
  });

  it("returns defaults for non-object input", () => {
    const config = normalizePluginConfig("garbage");
    expect(config.defaultMode).toBe("normal");
  });

  it("preserves valid values", () => {
    const config = normalizePluginConfig({
      enabledByDefault: true,
      defaultMode: "minimal",
      defaultLayout: "tiny1",
      defaultProgressMode: "strict",
      throttleMs: 3000,
      minThrottleMs: 1000,
      liveTickMs: 1500,
      maxRetriesEdit: 2,
      maxRetriesSend: 6,
      autoHideSeconds: 120,
      showInlineControls: true,
      newMessagePerRun: false,
    });
    expect(config.enabledByDefault).toBe(true);
    expect(config.defaultMode).toBe("minimal");
    expect(config.defaultProgressMode).toBe("strict");
    expect(config.throttleMs).toBe(3000);
    expect(config.minThrottleMs).toBe(1000);
    expect(config.liveTickMs).toBe(1500);
    expect(config.maxRetriesEdit).toBe(2);
    expect(config.maxRetriesSend).toBe(6);
    expect(config.autoHideSeconds).toBe(120);
    expect(config.showInlineControls).toBe(true);
    expect(config.newMessagePerRun).toBe(false);
  });

  it("clamps values below min", () => {
    const config = normalizePluginConfig({
      throttleMs: 10,
      minThrottleMs: 10,
      liveTickMs: 10,
      maxRetriesEdit: -5,
      maxRetriesSend: -1,
      autoHideSeconds: -10,
    });
    expect(config.throttleMs).toBe(250);
    expect(config.minThrottleMs).toBe(250);
    expect(config.liveTickMs).toBe(250);
    expect(config.maxRetriesEdit).toBe(0);
    expect(config.maxRetriesSend).toBe(0);
    expect(config.autoHideSeconds).toBe(0);
  });

  it("clamps values above max", () => {
    const config = normalizePluginConfig({
      throttleMs: 99999,
      minThrottleMs: 99999,
      liveTickMs: 99999,
      maxRetriesEdit: 100,
      maxRetriesSend: 100,
      autoHideSeconds: 9999,
    });
    expect(config.throttleMs).toBe(10000);
    expect(config.minThrottleMs).toBe(10000);
    expect(config.liveTickMs).toBe(10000);
    expect(config.maxRetriesEdit).toBe(4);
    expect(config.maxRetriesSend).toBe(10);
    expect(config.autoHideSeconds).toBe(600);
  });

  it("autoHideSeconds 0 means disabled", () => {
    const config = normalizePluginConfig({ autoHideSeconds: 0 });
    expect(config.autoHideSeconds).toBe(0);
  });

  it("rejects invalid mode values", () => {
    const config = normalizePluginConfig({ defaultMode: "fancy" });
    expect(config.defaultMode).toBe("normal");
  });

  it("rejects invalid progressMode values", () => {
    const config = normalizePluginConfig({ defaultProgressMode: "yolo" });
    expect(config.defaultProgressMode).toBe("predictive");
  });

  it("handles NaN and Infinity", () => {
    const config = normalizePluginConfig({
      throttleMs: NaN,
      minThrottleMs: Infinity,
      autoHideSeconds: -Infinity,
    });
    expect(config.throttleMs).toBe(4000); // fallback
    expect(config.minThrottleMs).toBe(2500); // fallback
    expect(config.autoHideSeconds).toBe(0); // fallback
  });
});

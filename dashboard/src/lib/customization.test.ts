import { describe, expect, test } from "bun:test";
import { classifyCustomAssetFile, MAX_CUSTOM_ASSET_BYTES } from "./customization";

describe("customization asset classification", () => {
  test("classifies image and video mime types", () => {
    expect(classifyCustomAssetFile({ name: "bg.png", type: "image/png" })).toBe("image");
    expect(classifyCustomAssetFile({ name: "bg.webm", type: "video/webm" })).toBe("video");
  });

  test("falls back to extension when mime type is empty", () => {
    expect(classifyCustomAssetFile({ name: "clip.mp4", type: "" })).toBe("video");
    expect(classifyCustomAssetFile({ name: "clip.mov", type: "" })).toBe("video");
    expect(classifyCustomAssetFile({ name: "pic.jpg", type: "" })).toBeNull();
  });

  test("rejects unsupported documents", () => {
    expect(classifyCustomAssetFile({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(classifyCustomAssetFile({ name: "data.json", type: "application/json" })).toBeNull();
  });
});

describe("customization storage limits", () => {
  test("hard cap is 200MB", () => {
    expect(MAX_CUSTOM_ASSET_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe("background defaults", () => {
  test("no stock image is shipped as the default background", async () => {
    // The console used to fall back to a bundled photograph, so a fresh
    // install showed a picture instead of its own theme colour and the
    // "Enable background" switch had no visible effect until a file was
    // picked. The theme is the default; a background is opt-in.
    const source = await Bun.file(
      new URL("../components/Atmosphere.tsx", import.meta.url),
    ).text();
    expect(source).not.toContain("default-backgrounds");
    expect(source).not.toContain("DEFAULT_BACKGROUND_URL");
  });

  test("a stored asset is required for the background layer to render", async () => {
    const source = await Bun.file(
      new URL("../components/Atmosphere.tsx", import.meta.url),
    ).text();
    // `backgroundEnabled` alone must not paint anything: it can be left on
    // from an earlier selection, and with no asset there is no image to show.
    expect(source).toContain("!settings.backgroundAsset");
  });
});

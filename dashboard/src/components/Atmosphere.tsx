import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useCustomizationAssetUrl, useCustomizationSettings } from "../lib/customization";

/**
 * The console's background layer.
 *
 * Nothing is painted unless the operator chose their own image or video: the
 * default is the theme itself, so light mode is its own paper tone and dark
 * mode is black. Shipping a stock image as the fallback put a photograph
 * behind every fresh install, which reads as a different product than the
 * palette the rest of the UI is built on — and it also meant the "Enable
 * background" switch did nothing visible until a file was picked.
 */
export function Atmosphere(): ReactNode {
  const [settings] = useCustomizationSettings();
  const assetUrl = useCustomizationAssetUrl(settings.backgroundAsset);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.glassEnabled) {
      root.dataset.glassEnabled = "true";
      root.dataset.glassDepth = String(settings.glassDepth);
    } else {
      delete root.dataset.glassEnabled;
      delete root.dataset.glassDepth;
    }
  }, [settings.glassDepth, settings.glassEnabled]);

  // Only an operator-supplied asset is a background. `backgroundEnabled` with
  // no asset means the switch was left on from an earlier selection; painting
  // the theme colour there is exactly what "no background" should look like.
  if (!settings.backgroundEnabled || !settings.backgroundAsset || !assetUrl) return null;
  const style: CSSProperties = {
    opacity: settings.backgroundOpacity / 100,
    ["--custom-bg-blur" as string]: `${settings.backgroundBlur}px`,
  };
  if (settings.backgroundAsset.kind === "video") {
    return (
      <video
        className="custom-background-layer"
        src={assetUrl}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        tabIndex={-1}
        aria-hidden="true"
        style={style}
      />
    );
  }
  return (
    <img
      className="custom-background-layer"
      src={assetUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={style}
    />
  );
}

// Renders a third-party ('iframe-bundle') addon inside the sandboxed iframe
// built in AddonIframeBridge.ts. This is the ONLY place addon-authored code
// (as opposed to this repo's own built-in "declarative" apps) ever runs.
import { useEffect, useRef, useState } from 'react';
import type { AddonAppDefinition, AddonManifest } from '../../types/addons';
import type { AddonSDK } from '../../services/AddonsSDK';
import { mountAddonIframe } from '../../services/addons/AddonIframeBridge';
import { readAddonBundleSource } from '../../services/addons/AddonInstallService';

type AddonIframeHostProps = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
  sdk: AddonSDK;
};

export default function AddonIframeHost({ manifest, app, sdk }: AddonIframeHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let handle: { destroy: () => void } | null = null;

    (async () => {
      try {
        if (!app.entryFile) {
          throw new Error(`Addon "${manifest.id}" app "${app.id}" has no entryFile`);
        }
        const bundleSource = await readAddonBundleSource(manifest.id, app.entryFile);
        if (cancelled || !containerRef.current) return;

        handle = mountAddonIframe({
          container: containerRef.current,
          bundleSource,
          sdk,
          onInitError: (message) => {
            if (!cancelled) setError(message);
          },
        });
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [manifest.id, app.id, app.entryFile, sdk]);

  if (error) {
    return (
      <div className="p-4">
        <div className="font-bold text-red-600">Addon failed to load</div>
        <div className="text-sm mt-1">{error}</div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[320px] w-full">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm wallet-muted">
          Loading addon…
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

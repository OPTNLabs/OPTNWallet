// Renders a third-party ('iframe-bundle') addon inside the sandboxed iframe
// built in AddonIframeBridge.ts. This is the ONLY place addon-authored code
// (as opposed to this repo's own built-in "declarative" apps) ever runs.
import { useEffect, useRef, useState } from 'react';
import type { AddonAppDefinition, AddonManifest } from '../../types/addons';
import type { AddonSDK } from '../../services/AddonsSDK';
import {
  mountAddonIframe,
  type MountedAddonIframe,
} from '../../services/addons/AddonIframeBridge';
import { readAddonBundleSource } from '../../services/addons/AddonInstallService';
import { useI18n } from '../../i18n/useI18n';
import { getAddonLocaleMessages } from '../../services/addons/AddonLocale';

type AddonIframeHostProps = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
  sdk: AddonSDK;
};

export default function AddonIframeHost({
  manifest,
  app,
  sdk,
}: AddonIframeHostProps) {
  const { t, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MountedAddonIframe | null>(null);
  const localeRef = useRef({
    locale,
    messages: getAddonLocaleMessages(manifest, locale),
  });
  localeRef.current = {
    locale,
    messages: getAddonLocaleMessages(manifest, locale),
  };
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let handle: MountedAddonIframe | null = null;

    (async () => {
      try {
        if (!app.entryFile) {
          throw new Error(
            `Addon "${manifest.id}" app "${app.id}" has no entryFile`
          );
        }
        const bundleSource = await readAddonBundleSource(
          manifest.id,
          app.entryFile
        );
        if (cancelled || !containerRef.current) return;

        handle = mountAddonIframe({
          container: containerRef.current,
          bundleSource,
          sdk,
          locale: localeRef.current.locale,
          localeMessages: localeRef.current.messages,
          onInitError: (message) => {
            if (!cancelled) setError(message);
          },
        });
        handleRef.current = handle;
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
      handleRef.current = null;
      handle?.destroy();
    };
  }, [manifest.id, app.id, app.entryFile, sdk]);

  useEffect(() => {
    handleRef.current?.setLocale(locale, localeRef.current.messages);
  }, [locale]);

  if (error) {
    return (
      <div className="p-4">
        <div className="font-bold text-red-600">
          {t('apps.addonLoadFailed')}
        </div>
        <div className="text-sm mt-1">{error}</div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[320px] w-full">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-sm wallet-muted">
          {t('apps.loadingAddon')}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

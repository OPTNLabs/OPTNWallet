const FALLBACK_WC_PROJECT_ID = 'f62aa2bb589104d059ca7b5bb64b18fb';

export function getWalletConnectProjectId(): string {
  const projectId = import.meta.env.VITE_WC_PROJECT_ID;
  return typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : FALLBACK_WC_PROJECT_ID;
}

export function getWalletConnectMetadataUrl(): string {
  return (
    import.meta.env.VITE_WC_METADATA_URL ||
    (typeof window !== 'undefined' && window.location?.origin) ||
    'https://optnlabs.com'
  );
}

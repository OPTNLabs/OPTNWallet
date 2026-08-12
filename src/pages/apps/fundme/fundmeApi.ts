const DEFAULT_FUNDME_API_BASE_URL = 'https://fundme.cash';

export function getFundMeApiBaseUrl(): string {
  const configured = import.meta.env.VITE_FUNDME_API_BASE_URL;

  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim().replace(/\/+$/, '');
  }

  return DEFAULT_FUNDME_API_BASE_URL;
}

export function fundMeApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getFundMeApiBaseUrl()}${normalizedPath}`;
}

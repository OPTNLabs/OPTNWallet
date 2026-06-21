// Desktop shim for @capacitor/core
// isNativePlatform() → false causes all mobile-only code paths to self-exclude

export const Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => 'web' as const,
  isPluginAvailable: (_name: string) => false,
  convertFileSrc: (path: string) => path,
};

export const registerPlugin = <T>(_name: string, _impl?: object): T => {
  return {} as T;
};

export type PluginListenerHandle = { remove: () => Promise<void> };

// CapacitorHttp — on native it bypasses CORS; on desktop we use fetch directly
type HttpOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  params?: Record<string, string>;
  responseType?: string;
  connectTimeout?: number;
  readTimeout?: number;
  shouldEncodeUrlParams?: boolean;
  dataType?: string;
};

type HttpResponse = {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  url: string;
};

async function capHttpRequest(options: HttpOptions): Promise<HttpResponse> {
  let url = options.url;
  if (options.params) {
    const qs = new URLSearchParams(options.params).toString();
    url = `${url}${url.includes('?') ? '&' : '?'}${qs}`;
  }
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.data != null ? JSON.stringify(options.data) : undefined,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  let data: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { data, status: res.status, headers, url: res.url };
}

export const CapacitorHttp = {
  request: (opts: HttpOptions) => capHttpRequest(opts),
  get: (opts: HttpOptions) => capHttpRequest({ ...opts, method: 'GET' }),
  post: (opts: HttpOptions) => capHttpRequest({ ...opts, method: 'POST' }),
  put: (opts: HttpOptions) => capHttpRequest({ ...opts, method: 'PUT' }),
  patch: (opts: HttpOptions) => capHttpRequest({ ...opts, method: 'PATCH' }),
  delete: (opts: HttpOptions) => capHttpRequest({ ...opts, method: 'DELETE' }),
};

export function ipfsFetch(uri, options?) {
  let fetchUri = uri;
  if (!uri.startsWith('ipfs://') && !uri.startsWith('https://')) {
    fetchUri = `https://${fetchUri}`;
  }

  if (uri.startsWith('ipfs://')) {
    const uriSlice = uri.slice(7);
    fetchUri = `https://ipfs.io/ipfs/${uriSlice}`;
  }

  return fetch(fetchUri, options);
}

export const connect = () => {
  throw new Error('tls.connect not available in browser');
};
export class TLSSocket {}
export default {} as Record<string, never>;

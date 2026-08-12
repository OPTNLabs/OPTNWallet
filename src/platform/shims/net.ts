export const isIP = () => 0;
export const connect = () => {
  throw new Error('net.connect not available in browser');
};
export default {} as Record<string, never>;

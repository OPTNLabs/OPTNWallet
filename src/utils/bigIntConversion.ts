// Convert an object with BigInt values to string
export function bigIntToString(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(bigIntToString);
  } else if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, bigIntToString(value)])
    );
  } else if (typeof obj === 'bigint') {
    return obj.toString();
  } else {
    return obj;
  }
}

// Convert an object with stringified BigInt values back to BigInt
export function stringToBigInt(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(stringToBigInt);
  } else if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, stringToBigInt(value)])
    );
  } else if (typeof obj === 'string' && /^[0-9]+$/.test(obj)) {
    return BigInt(obj);
  } else {
    return obj;
  }
}

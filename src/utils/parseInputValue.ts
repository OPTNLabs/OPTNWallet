export default function parseInputValue(value, type) {
  switch (type) {
    case 'int':
      return BigInt(value);
    case 'bool':
      return value === 'true';
    case 'string':
      return value;
    case 'bytes':
      return value;
    case 'pubkey':
      return value;
    case 'sig':
      return value;
    case 'datasig':
      return value;
    default:
      return value;
  }
}

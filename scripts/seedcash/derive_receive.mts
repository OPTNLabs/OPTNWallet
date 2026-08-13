import {
  decodeHdPublicKey,
  deriveHdPathRelative,
  encodeCashAddress,
  hash160,
  binToHex,
} from '@bitauth/libauth';

const xpub =
  process.argv[2] ||
  'xpub6ByHsPNSQXTWZ7PLESMY2FufyYWtLXagSUpMQq7Un96SiThZH2iJB1X7pwviH1WtKVeDP6K8d6xxFzzoaFzF3s8BKCZx8oEDdDkNnp4owAZ';
const branch = process.argv[3] || '0/0';
const prefix = process.argv[4] || 'bchtest';

const acc = decodeHdPublicKey(xpub);
if (typeof acc === 'string') throw new Error(acc);
const child = deriveHdPathRelative(acc.node, branch);
if (typeof child === 'string') throw new Error(child);
const payload = hash160(child.publicKey);
const addr = encodeCashAddress({ payload, prefix, type: 'p2pkh' }).address;
console.log(
  JSON.stringify(
    {
      address: addr,
      publicKeyHex: binToHex(child.publicKey),
      branch,
      accountPath: "m/44'/145'/0'",
      fingerprint: '73c5da0a',
    },
    null,
    2
  )
);

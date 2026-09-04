import { generateMnemonic } from 'bip39';
import { hexToBytes } from '@noble/hashes/utils';
import { createGroup, joinGroup, processMessage } from 'ts-mls';
import {
  generateSecretKey,
  getPublicKey,
  SimplePool,
  type Event,
} from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip17';
import { wrapManyEvents as wrapRumor } from 'nostr-tools/nip59';
import { deriveNostrIdentity } from '../src/platform/desktop/nostr/identity';
import {
  buildKind445,
  commitAddMember,
  decodeMlsBytes,
  decryptKind445Content,
  encryptMlsMessage,
  ensureMlsCrypto,
  generateMlsKeyPackage,
  innerKind9,
  KIND_GROUP,
  KIND_WELCOME,
  mlsContext,
  parseApplicationPayload,
  unsignedKind444,
  unsignedMlsRumor,
} from '../src/platform/desktop/nostr/mls';

const RELAYS = [
  'wss://relay.paytaca.com',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

type Check = {
  path: 'dm' | 'private' | 'open';
  ok: boolean;
  decrypt: boolean;
  recovered: boolean | null;
  leak: boolean;
  note: string;
};

function leak(hay: unknown, needle: string): boolean {
  return JSON.stringify(hay).includes(needle);
}

function createUnsignedKind14(
  content: string,
  senderPubKey: string,
  members: string[]
) {
  const tags: string[][] = [];
  for (const member of members) {
    if (member !== senderPubKey) tags.push(['p', member]);
  }
  return {
    kind: 14,
    pubkey: senderPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
}

async function publishAll(pool: SimplePool, events: Event[]) {
  await Promise.allSettled(events.flatMap((ev) => pool.publish(RELAYS, ev)));
}

async function recover1059(
  pool: SimplePool,
  sk: Uint8Array,
  pk: string,
  match: (inner: ReturnType<typeof unwrapEvent>) => boolean
) {
  const got = new Promise<ReturnType<typeof unwrapEvent>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20_000);
    const sub = pool.subscribeMany(RELAYS, [{ kinds: [1059], '#p': [pk] }], {
      onevent(ev) {
        try {
          const inner = unwrapEvent(ev, sk);
          if (match(inner)) {
            clearTimeout(timer);
            sub.close();
            resolve(inner);
          }
        } catch {
          /* not ours */
        }
      },
    });
  });
  try {
    return await got;
  } catch {
    const fetched = await pool.querySync(RELAYS, {
      kinds: [1059],
      '#p': [pk],
      since: Math.floor(Date.now() / 1000) - 2 * 24 * 3600,
    });
    for (const ev of fetched) {
      try {
        const inner = unwrapEvent(ev, sk);
        if (match(inner)) return inner;
      } catch {
        /* skip */
      }
    }
    return null;
  }
}

async function recoverKind445(pool: SimplePool, nostrGroupIdHex: string) {
  const filter = { kinds: [KIND_GROUP], '#h': [nostrGroupIdHex] };
  const got = new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 20_000);
    const sub = pool.subscribeMany(RELAYS, [filter], {
      onevent(ev) {
        if (ev.kind === KIND_GROUP) {
          clearTimeout(timer);
          sub.close();
          resolve(ev);
        }
      },
    });
  });
  try {
    return await got;
  } catch {
    const fetched = await pool.querySync(RELAYS, {
      ...filter,
      since: Math.floor(Date.now() / 1000) - 3600,
    });
    return fetched.find((ev) => ev.kind === KIND_GROUP) ?? null;
  }
}

async function checkDm(text: string, live: boolean): Promise<Check> {
  const aSk = generateSecretKey();
  const bSk = generateSecretKey();
  const aPk = getPublicKey(aSk);
  const bPk = getPublicKey(bSk);
  const rumor = createUnsignedKind14(text, aPk, [aPk, bPk]);
  const wraps = wrapRumor(rumor, aSk, [bPk]) as Event[];
  const forB = wraps.find((w) =>
    w.tags.some((t) => t[0] === 'p' && t[1] === bPk)
  );
  if (!forB) throw new Error('dm: missing wrap');
  const local = unwrapEvent(forB, bSk);
  const decrypt = local.content === text && local.pubkey === aPk;
  const leaked = leak(forB, text);
  let recovered: boolean | null = null;
  if (live) {
    const pool = new SimplePool();
    try {
      await new Promise((r) => setTimeout(r, 800));
      await publishAll(pool, wraps);
      const inner = await recover1059(
        pool,
        bSk,
        bPk,
        (ev) => ev.content === text && ev.pubkey === aPk
      );
      recovered = inner?.content === text;
    } finally {
      pool.close(RELAYS);
    }
  }
  return {
    path: 'dm',
    ok: decrypt && !leaked && (live ? recovered === true : true),
    decrypt,
    recovered,
    leak: leaked,
    note: 'NIP-17 kind 14 in 1059',
  };
}

async function mlsPair() {
  const mnemonicA = generateMnemonic();
  const mnemonicB = generateMnemonic();
  const a = await deriveNostrIdentity(mnemonicA);
  const b = await deriveNostrIdentity(mnemonicB);
  const { impl } = await ensureMlsCrypto();
  const aKp = await generateMlsKeyPackage(a.pubkey, mnemonicA, '', {
    identitySecret: a.secretKey,
  });
  const bKp = await generateMlsKeyPackage(b.pubkey, mnemonicB, '', {
    identitySecret: b.secretKey,
  });
  return { a, b, impl, aKp, bKp };
}

async function twoMemberGroup(pair: Awaited<ReturnType<typeof mlsPair>>) {
  const groupId = crypto.getRandomValues(new Uint8Array(32));
  const nostrGroupIdHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
  const aState = await createGroup({
    context: mlsContext(pair.impl),
    groupId,
    keyPackage: pair.aKp.publicPackage,
    privateKeyPackage: pair.aKp.privatePackage,
  });
  const committed = await commitAddMember(aState, pair.bKp.publicPackage);
  if (!committed.welcome) throw new Error('missing welcome');
  const joinOpts = {
    context: mlsContext(pair.impl),
    welcome: committed.welcome.welcome,
    keyPackage: pair.bKp.publicPackage,
    privateKeys: pair.bKp.privatePackage,
  };
  return {
    nostrGroupIdHex,
    committed,
    bStateLocal: await joinGroup(joinOpts),
    bStateRelay: await joinGroup(joinOpts),
  };
}

async function checkPrivate(text: string, live: boolean): Promise<Check> {
  const pair = await mlsPair();
  const group = await twoMemberGroup(pair);
  const sent = await encryptMlsMessage(
    group.committed.newState,
    JSON.stringify(innerKind9(pair.a.pubkey, text))
  );
  const local = await processMessage({
    context: mlsContext(pair.impl),
    state: group.bStateLocal,
    message: sent.message,
  });
  const decrypt =
    local.kind === 'applicationMessage' &&
    parseApplicationPayload(local.message).text === text;

  const rumor = unsignedMlsRumor(
    pair.a.pubkey,
    group.nostrGroupIdHex,
    sent.message
  );
  const wraps = wrapRumor(rumor, pair.a.secretKey, [pair.b.pubkey]) as Event[];
  const outer = wraps.find((w) =>
    w.tags.some((t) => t[0] === 'p' && t[1] === pair.b.pubkey)
  );
  if (!outer) throw new Error('private: missing wrap');
  const leaked = leak(outer, text);
  const outerH = outer.tags.some((t) => t[0] === 'h');

  let recovered: boolean | null = null;
  if (live) {
    const welcome = unsignedKind444(
      pair.a.pubkey,
      group.committed.welcome!,
      RELAYS
    );
    const welcomeWraps = wrapRumor(welcome, pair.a.secretKey, [
      pair.b.pubkey,
    ]) as Event[];
    const pool = new SimplePool();
    try {
      await new Promise((r) => setTimeout(r, 800));
      await publishAll(pool, [...welcomeWraps, ...wraps]);
      const inner = await recover1059(
        pool,
        pair.b.secretKey,
        pair.b.pubkey,
        (ev) =>
          ev.kind === KIND_GROUP &&
          ev.tags.some((t) => t[0] === 'h' && t[1] === group.nostrGroupIdHex)
      );
      if (inner) {
        const mlsMsg = decodeMlsBytes(hexToBytes(inner.content));
        if (mlsMsg) {
          const processed = await processMessage({
            context: mlsContext(pair.impl),
            state: group.bStateRelay,
            message: mlsMsg,
          });
          recovered =
            processed.kind === 'applicationMessage' &&
            parseApplicationPayload(processed.message).text === text;
        } else {
          recovered = false;
        }
      } else {
        recovered = false;
      }
    } finally {
      pool.close(RELAYS);
    }
  }

  return {
    path: 'private',
    ok: decrypt && !leaked && !outerH && (live ? recovered === true : true),
    decrypt,
    recovered,
    leak: leaked,
    note: outerH ? 'outer wrap leaked h tag' : 'gift-wrap 1059, no outer h',
  };
}

async function checkOpen(text: string, live: boolean): Promise<Check> {
  const pair = await mlsPair();
  const group = await twoMemberGroup(pair);
  const sent = await encryptMlsMessage(
    group.committed.newState,
    JSON.stringify(innerKind9(pair.a.pubkey, text))
  );
  const local = await processMessage({
    context: mlsContext(pair.impl),
    state: group.bStateLocal,
    message: sent.message,
  });
  const decrypt =
    local.kind === 'applicationMessage' &&
    parseApplicationPayload(local.message).text === text;

  const evt = await buildKind445(
    sent.newState,
    sent.message,
    group.nostrGroupIdHex
  );
  const leaked = leak(evt, text);
  const hasH = evt.tags.some(
    (t) => t[0] === 'h' && t[1] === group.nostrGroupIdHex
  );
  const ephemeral = evt.pubkey !== pair.a.pubkey;

  const fromWire = await decryptKind445Content(group.bStateRelay, evt.content);
  let wireOk = false;
  if (fromWire && !live) {
    const processed = await processMessage({
      context: mlsContext(pair.impl),
      state: group.bStateRelay,
      message: fromWire,
    });
    wireOk =
      processed.kind === 'applicationMessage' &&
      parseApplicationPayload(processed.message).text === text;
  } else {
    wireOk = fromWire != null;
  }

  let recovered: boolean | null = null;
  if (live) {
    const pool = new SimplePool();
    try {
      await new Promise((r) => setTimeout(r, 800));
      await publishAll(pool, [evt]);
      const got = await recoverKind445(pool, group.nostrGroupIdHex);
      if (!got) {
        recovered = false;
      } else {
        const mlsMsg = await decryptKind445Content(
          group.bStateRelay,
          got.content
        );
        if (!mlsMsg) {
          recovered = false;
        } else {
          const processed = await processMessage({
            context: mlsContext(pair.impl),
            state: group.bStateRelay,
            message: mlsMsg,
          });
          recovered =
            processed.kind === 'applicationMessage' &&
            parseApplicationPayload(processed.message).text === text;
        }
      }
    } finally {
      pool.close(RELAYS);
    }
  }

  return {
    path: 'open',
    ok:
      decrypt &&
      wireOk &&
      !leaked &&
      hasH &&
      ephemeral &&
      (live ? recovered === true : true),
    decrypt: decrypt && wireOk,
    recovered,
    leak: leaked,
    note: `kind 445 h=${hasH} ephemeral=${ephemeral}`,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npx tsx scripts/chat-cli.mts [dm|private|open|all] [--live]',
      '',
      '  dm       NIP-17 gift-wrap DM',
      '  private  MLS group, messages gift-wrapped (kind 1059)',
      '  open     MLS group, public kind 445',
      '  all      all three (default)',
      '  --live   also publish/recover on relays (slow)',
      '',
    ].join('\n')
  );
}

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function yn(v: boolean | null) {
  if (v === null) return '-';
  return v ? 'yes' : 'no';
}

export async function runChatCli(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return 0;
  }
  const live = argv.includes('--live');
  const paths = argv.filter((a) => a !== '--live' && a !== '--');
  const pick = (paths[0] ?? 'all') as 'dm' | 'private' | 'open' | 'all';
  if (!['dm', 'private', 'open', 'all'].includes(pick)) {
    printHelp();
    return 2;
  }

  const token = `optn-cli-${Date.now()}`;
  const wanted: Array<'dm' | 'private' | 'open'> =
    pick === 'all' ? ['dm', 'private', 'open'] : [pick];

  const checks: Check[] = [];
  for (const path of wanted) {
    const text = `${path} ${token}`;
    if (path === 'dm') checks.push(await checkDm(text, live));
    else if (path === 'private') checks.push(await checkPrivate(text, live));
    else checks.push(await checkOpen(text, live));
  }

  process.stdout.write(
    `\nchat-cli  mode=${live ? 'live' : 'local'}  relays=${live ? RELAYS.join(',') : 'none'}\n`
  );
  process.stdout.write(
    `${pad('path', 10)}${pad('ok', 6)}${pad('decrypt', 10)}${pad('recovered', 12)}${pad('leak', 8)}note\n`
  );
  for (const c of checks) {
    process.stdout.write(
      `${pad(c.path, 10)}${pad(c.ok ? 'yes' : 'no', 6)}${pad(yn(c.decrypt), 10)}${pad(yn(c.recovered), 12)}${pad(yn(c.leak), 8)}${c.note}\n`
    );
  }
  process.stdout.write('\n');
  process.stdout.write(
    JSON.stringify({ ok: checks.every((c) => c.ok), live, checks }) + '\n'
  );
  return checks.every((c) => c.ok) ? 0 : 1;
}

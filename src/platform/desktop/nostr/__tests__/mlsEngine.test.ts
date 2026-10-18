// The chat's two MLS engines behind one set of calls: each group's calls go
// to the engine that holds it, and MDK's events become the chat's messages.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  tsMls: {
    addMlsMember: vi.fn(async () => undefined),
    createMlsGroup: vi.fn(async () => ({ engine: 'ts-mls' })),
    sendMlsFile: vi.fn(async () => ({ id: 'ts', at: 1 })),
    listMlsGroups: vi.fn(() => []),
  },
  secret: new Uint8Array(32).fill(7),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../mls', () => mocks.tsMls);
vi.mock('../identity', async (actual) => ({
  ...(await actual<typeof import('../identity')>()),
  loadNostrAccountSeed: vi.fn(async () => ({})),
  deriveNostrIdentityFromSeed: vi.fn(async () => ({
    secretKey: mocks.secret,
    pubkey: 'aa'.repeat(32),
    npub: 'npub',
  })),
}));

const view = (partial: Record<string, unknown> = {}) => ({
  mlsGroupId: 'ab'.repeat(16),
  nostrGroupId: 'cd'.repeat(32),
  name: 'ops',
  description: '',
  admins: ['aa'.repeat(32)],
  members: ['aa'.repeat(32), 'bb'.repeat(32)],
  relays: ['wss://relay.example.org'],
  active: true,
  epoch: 1,
  ...partial,
});

describe('chat engines', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sends an MDK group's calls to the host and a ts-mls group's to ts-mls", async () => {
    mocks.invoke.mockResolvedValue(view());
    const engine = await import('../mlsEngine');

    await engine.addMlsMember(1, `mdk:${'ab'.repeat(16)}`, 'bb'.repeat(32));
    expect(mocks.invoke).toHaveBeenCalledWith('chat_mdk_call', {
      op: 'addMembers',
      args: { group: 'ab'.repeat(16), members: ['bb'.repeat(32)] },
    });
    expect(mocks.tsMls.addMlsMember).not.toHaveBeenCalled();

    await engine.addMlsMember(1, 'ef'.repeat(32), 'bb'.repeat(32), ['wss://r']);
    expect(mocks.tsMls.addMlsMember).toHaveBeenCalledWith(
      1,
      'ef'.repeat(32),
      'bb'.repeat(32),
      ['wss://r'],
      undefined
    );
    // The first import of the engine pulls in ts-mls, which can take over 5 s.
  }, 20_000);

  it('makes new open groups on MDK only when asked, and private groups never', async () => {
    mocks.invoke.mockResolvedValue(view());
    const engine = await import('../mlsEngine');

    const made = await engine.createMlsGroup(1, 'ops', 'aa'.repeat(32), {
      visibility: 'open',
      relays: ['wss://relay.example.org'],
      engine: 'mdk',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('chat_mdk_call', {
      op: 'createGroup',
      args: { name: 'ops', members: [], relays: ['wss://relay.example.org'] },
    });
    expect(made).toMatchObject({
      engine: 'mdk',
      nostrGroupIdHex: `mdk:${'ab'.repeat(16)}`,
      roomId: `mdk:${'ab'.repeat(16)}`,
      visibility: 'open',
      memberPubKeys: ['aa'.repeat(32), 'bb'.repeat(32)],
    });

    await engine.createMlsGroup(1, 'quiet', 'aa'.repeat(32), {
      visibility: 'private',
      engine: 'mdk',
    });
    expect(mocks.tsMls.createMlsGroup).toHaveBeenCalledTimes(1);
    await engine.createMlsGroup(1, 'town', 'aa'.repeat(32), {
      visibility: 'open',
    });
    expect(mocks.tsMls.createMlsGroup).toHaveBeenCalledTimes(2);
  });

  it('sends a file to an MDK group with its type and name', async () => {
    mocks.invoke.mockResolvedValue({ id: 'ff'.repeat(32), at: 5 });
    const engine = await import('../mlsEngine');

    const sent = await engine.sendMlsFile(
      1,
      `mdk:${'ab'.repeat(16)}`,
      `mdk:${'ab'.repeat(16)}`,
      'data:image/png;base64,AA',
      [],
      { mimeType: 'image/png', fileName: 'a.png' }
    );
    expect(sent).toEqual({ id: 'ff'.repeat(32), at: 5 });
    expect(mocks.invoke).toHaveBeenCalledWith('chat_mdk_call', {
      op: 'send',
      args: {
        group: 'ab'.repeat(16),
        kind: 15,
        content: 'data:image/png;base64,AA',
        tags: [
          ['file-type', 'image/png'],
          ['filename', 'a.png'],
        ],
      },
    });
    expect(mocks.tsMls.sendMlsFile).not.toHaveBeenCalled();
  });

  it("turns MDK's events into the chat's messages and groups, and wipes the identity it handed over", async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (_name, handler) => {
      deliver = handler;
      return () => undefined;
    });
    mocks.invoke.mockImplementation(async (command: string, args) => {
      if (command === 'chat_mdk_open') {
        expect(args.identity).toBe('07'.repeat(32));
        return { publicKey: 'aa'.repeat(32), groups: [view()] };
      }
      if (args?.op === 'messages') return [];
      return null;
    });
    const { openMdkChat, mdkGroups } = await import('../mdkChat');

    const onMessage = vi.fn();
    const onGroups = vi.fn();
    const close = await openMdkChat(1, ['wss://relay.example.org'], {
      onMessage,
      onGroups,
    });
    expect(mocks.listen).toHaveBeenCalledBefore(mocks.invoke);
    expect([...mocks.secret]).toEqual(new Array(32).fill(0));
    expect(mdkGroups('aa'.repeat(32)).map((group) => group.name)).toEqual([
      'ops',
    ]);

    deliver!({
      payload: {
        type: 'message',
        id: '11'.repeat(32),
        mlsGroupId: 'ab'.repeat(16),
        from: 'bb'.repeat(32),
        kind: 9,
        content: 'hello',
        tags: [],
        at: 7,
        mine: false,
      },
    });
    expect(onMessage).toHaveBeenCalledWith({
      id: '11'.repeat(32),
      from: 'bb'.repeat(32),
      to: [],
      text: 'hello',
      at: 7,
      mine: false,
      kind: 9,
      roomId: `mdk:${'ab'.repeat(16)}`,
    });

    // Removed from the group: it is no longer a chat.
    deliver!({
      payload: { type: 'changed', ...view({ active: false, members: [] }) },
    });
    expect(mdkGroups('aa'.repeat(32))).toEqual([]);
    expect(onGroups).toHaveBeenCalled();
    close();
  });
});

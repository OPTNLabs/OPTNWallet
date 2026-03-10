import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { DecodedMemoRow, MemoAction } from './services/memoDecoder';
import {
  fetchDecodedMemoPage,
  MEMO_PREFIX,
  type MemoPageCursor,
} from './services/chaingraphMemoClient';

type Props = {
  sdk: AddonSDK;
};

type ProfileState = {
  name?: string;
  text?: string;
  picture?: string;
  updatedAt: bigint;
};

type LoadedPage = {
  rows: DecodedMemoRow[];
  nextCursor: MemoPageCursor | null;
  hasMore: boolean;
  suppressedCount: number;
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_DUPLICATE_POSTS_PER_MESSAGE = 3;
const QUERY_BATCH_MULTIPLIER = 6;
const MAX_BATCH_ROUNDS = 8;
const MIN_REQUEST_GAP_MS = 450;

function actionLabel(action: MemoAction): string {
  switch (action.type) {
    case 'post':
      return 'Post';
    case 'reply':
      return 'Reply';
    case 'set_name':
      return 'Set Name';
    case 'set_profile_text':
      return 'Set Profile Text';
    case 'set_profile_picture':
      return 'Set Profile Picture';
    case 'follow':
      return 'Follow';
    case 'unfollow':
      return 'Unfollow';
    case 'like_tip':
      return 'Like/Tip';
    case 'post_topic':
      return 'Topic Post';
    default:
      return 'Memo';
  }
}

function excerpt(action: MemoAction): string {
  switch (action.type) {
    case 'post':
      return action.message;
    case 'reply':
      return action.message;
    case 'set_name':
      return action.name;
    case 'set_profile_text':
      return action.text;
    case 'set_profile_picture':
      return action.url;
    case 'post_topic':
      return `${action.topic} ${action.message}`.trim();
    case 'follow':
    case 'unfollow':
      return action.address;
    case 'like_tip':
      return action.txid;
    default:
      return '';
  }
}

function isReplyTo(
  postTxid: string,
  replyAction: Extract<MemoAction, { type: 'reply' }>
) {
  if (!replyAction.txid) return false;
  return replyAction.txid === postTxid || replyAction.txidAlt === postTxid;
}

function normalizeRepeatedMessage(action: MemoAction): string | null {
  if (action.type !== 'post' && action.type !== 'post_topic') return null;

  const raw =
    action.type === 'post'
      ? action.message
      : `${action.topic} ${action.message}`.trim();

  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

function buildProfilesByAddress(rows: DecodedMemoRow[]): Map<string, ProfileState> {
  const profiles = new Map<string, ProfileState>();

  for (const row of rows) {
    const addr = row.actorAddress;
    if (!addr) continue;

    const current = profiles.get(addr);
    const currentTs = current?.updatedAt ?? -1n;
    if (row.internalId < currentTs) continue;

    if (row.action.type === 'set_name') {
      profiles.set(addr, {
        ...(current ?? { updatedAt: row.internalId }),
        name: row.action.name,
        updatedAt: row.internalId,
      });
      continue;
    }

    if (row.action.type === 'set_profile_text') {
      profiles.set(addr, {
        ...(current ?? { updatedAt: row.internalId }),
        text: row.action.text,
        updatedAt: row.internalId,
      });
      continue;
    }

    if (row.action.type === 'set_profile_picture') {
      profiles.set(addr, {
        ...(current ?? { updatedAt: row.internalId }),
        picture: row.action.url,
        updatedAt: row.internalId,
      });
    }
  }

  return profiles;
}

export default function MemoCashReaderApp({ sdk }: Props) {
  const [network, setNetwork] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const [prefix, setPrefix] = useState<string>(MEMO_PREFIX.post);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [pages, setPages] = useState<LoadedPage[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [nameOverrides, setNameOverrides] = useState<Map<string, string>>(
    new Map()
  );
  const [queryingLabel, setQueryingLabel] = useState<string>('');
  const lastRequestAtRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const ctx = sdk.wallet.getContext();
        if (mounted) setNetwork(ctx.network);
      } catch {
        if (mounted) setNetwork(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sdk]);

  const fetchRecentNames = useCallback(async () => {
    // Best-effort profile pass so names can appear even in Posts-only mode.
    let cursor: MemoPageCursor | null = null;
    const merged = new Map<string, string>();

    for (let i = 0; i < 3; i += 1) {
      const batch = await fetchDecodedMemoPage({
        sdk,
        network,
        limit: 200,
        cursor,
        prefix: MEMO_PREFIX.set_name,
      });

      for (const row of batch.rows) {
        if (!row.actorAddress) continue;
        if (row.action.type !== 'set_name') continue;
        if (!row.action.name.trim()) continue;
        if (!merged.has(row.actorAddress)) {
          merged.set(row.actorAddress, row.action.name.trim());
        }
      }

      if (!batch.nextCursor || batch.sourceRowCount < 200) break;
      cursor = batch.nextCursor;
    }

    setNameOverrides(merged);
  }, [network, sdk]);

  const fetchPage = useCallback(
    async (
      cursor: MemoPageCursor | null,
      priorSeenByMessage?: Map<string, number>
    ): Promise<LoadedPage> => {
      const queryBatchSize = Math.max(
        pageSize * QUERY_BATCH_MULTIPLIER,
        pageSize + 10
      );

      const seenByMessage = new Map(priorSeenByMessage ?? []);
      const kept: DecodedMemoRow[] = [];
      const seenIds = new Set<string>();
      let suppressedCount = 0;
      let roundCursor = cursor;
      let hasMore = false;

      for (let round = 0; round < MAX_BATCH_ROUNDS; round += 1) {
        const batch = await fetchDecodedMemoPage({
          sdk,
          network,
          limit: queryBatchSize,
          cursor: roundCursor,
          prefix,
        });

        const sortedRows = [...batch.rows].sort((a, b) => {
          if (a.internalId === b.internalId) return a.outputIndex - b.outputIndex;
          return a.internalId > b.internalId ? -1 : 1;
        });

        for (const row of sortedRows) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);

          const key = normalizeRepeatedMessage(row.action);
          if (key) {
            const seen = seenByMessage.get(key) ?? 0;
            if (seen >= MAX_DUPLICATE_POSTS_PER_MESSAGE) {
              suppressedCount += 1;
              continue;
            }
            seenByMessage.set(key, seen + 1);
          }

          kept.push(row);
          if (kept.length >= pageSize) break;
        }

        hasMore =
          batch.nextCursor !== null && batch.sourceRowCount >= queryBatchSize;
        roundCursor = batch.nextCursor;

        if (kept.length >= pageSize) break;
        if (!hasMore) break;
      }

      return {
        rows: kept.slice(0, pageSize),
        nextCursor: roundCursor,
        hasMore,
        suppressedCount,
      };
    },
    [network, pageSize, prefix, sdk]
  );

  const loadFirstPage = useCallback(async () => {
    if (busyRef.current) return;
    const now = Date.now();
    if (now - lastRequestAtRef.current < MIN_REQUEST_GAP_MS) return;
    busyRef.current = true;
    lastRequestAtRef.current = now;
    setLoading(true);
    setQueryingLabel('Refreshing latest posts...');
    setError('');
    try {
      await fetchRecentNames().catch(() => undefined);
      const first = await fetchPage(null);
      setPages([first]);
      setCurrentPage(1);
    } catch (e: unknown) {
      setPages([]);
      setCurrentPage(1);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
      setQueryingLabel('');
    }
  }, [fetchPage, fetchRecentNames]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const activePage = pages[currentPage - 1] ?? null;

  const allLoadedRows = useMemo(() => {
    const out: DecodedMemoRow[] = [];
    const seen = new Set<string>();

    for (const page of pages) {
      for (const row of page.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }
    }

    return out;
  }, [pages]);

  const profilesByAddress = useMemo(() => {
    const fromRows = buildProfilesByAddress(allLoadedRows);
    for (const [addr, name] of nameOverrides.entries()) {
      const current = fromRows.get(addr);
      fromRows.set(addr, {
        ...(current ?? { updatedAt: 0n }),
        name,
        updatedAt: current?.updatedAt ?? 0n,
      });
    }
    return fromRows;
  }, [allLoadedRows, nameOverrides]);

  const pageRows = useMemo(() => activePage?.rows ?? [], [activePage]);

  const replies = useMemo(
    () => pageRows.filter((item) => item.action.type === 'reply'),
    [pageRows]
  );

  const rowsToRender = useMemo(() => {
    if (prefix === MEMO_PREFIX.post) {
      return pageRows.filter(
        (item) => item.action.type === 'post' || item.action.type === 'post_topic'
      );
    }
    return pageRows;
  }, [pageRows, prefix]);

  const handlePageSizeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const nextSize = Number.parseInt(e.target.value, 10);
    if (![10, 20, 30].includes(nextSize)) return;
    setPageSize(nextSize);
  };

  const handleNextPage = async () => {
    if (loading || busyRef.current) return;

    // Move into already-cached page.
    if (currentPage < pages.length) {
      setCurrentPage((p) => p + 1);
      return;
    }

    const last = pages[pages.length - 1];
    if (!last?.hasMore) return;
    const now = Date.now();
    if (now - lastRequestAtRef.current < MIN_REQUEST_GAP_MS) return;
    busyRef.current = true;
    lastRequestAtRef.current = now;

    const priorSeenByMessage = new Map<string, number>();
    for (const page of pages) {
      for (const row of page.rows) {
        const key = normalizeRepeatedMessage(row.action);
        if (!key) continue;
        priorSeenByMessage.set(key, (priorSeenByMessage.get(key) ?? 0) + 1);
      }
    }

    setLoading(true);
    setQueryingLabel('Loading older posts...');
    setError('');
    try {
      const next = await fetchPage(last.nextCursor, priorSeenByMessage);
      setPages((prev) => [...prev, next]);
      setCurrentPage((prev) => prev + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
      setQueryingLabel('');
    }
  };

  const handlePreviousPage = () => {
    setCurrentPage((p) => Math.max(1, p - 1));
  };

  const handleFirstPage = () => {
    setCurrentPage(1);
  };

  const handleLastLoadedPage = () => {
    if (pages.length === 0) return;
    setCurrentPage(pages.length);
  };

  return (
    <div className="wallet-page p-4 max-w-3xl mx-auto h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] flex flex-col overflow-hidden">
      <div className="wallet-card p-4 mb-4 shrink-0">
        <div className="text-xl font-semibold">Memo.cash Reader</div>
        <div className="wallet-muted text-sm mt-1">
          Cursor-paginated OP_RETURN feed from Chaingraph.
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className={`wallet-btn-secondary ${prefix === MEMO_PREFIX.any ? 'ring-2 ring-[var(--wallet-accent)]' : ''}`}
            onClick={() => setPrefix(MEMO_PREFIX.any)}
            disabled={loading}
          >
            All Memo
          </button>
          <button
            className={`wallet-btn-secondary ${prefix === MEMO_PREFIX.post ? 'ring-2 ring-[var(--wallet-accent)]' : ''}`}
            onClick={() => setPrefix(MEMO_PREFIX.post)}
            disabled={loading}
          >
            Posts
          </button>
          <button
            className={`wallet-btn-secondary ${prefix === MEMO_PREFIX.reply ? 'ring-2 ring-[var(--wallet-accent)]' : ''}`}
            onClick={() => setPrefix(MEMO_PREFIX.reply)}
            disabled={loading}
          >
            Replies
          </button>
          <button
            className={`wallet-btn-secondary ${prefix === MEMO_PREFIX.set_name ? 'ring-2 ring-[var(--wallet-accent)]' : ''}`}
            onClick={() => setPrefix(MEMO_PREFIX.set_name)}
            disabled={loading}
          >
            Names
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <select
            value={pageSize}
            onChange={handlePageSizeChange}
            className="wallet-input py-2 px-3 text-sm"
            disabled={loading}
          >
            <option value={10}>10 per page</option>
            <option value={20}>20 per page</option>
            <option value={30}>30 per page</option>
          </select>
          <button
            className="wallet-btn-primary"
            onClick={() => void loadFirstPage()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="wallet-danger-panel p-3 rounded mb-3 text-sm shrink-0">
          {error}
        </div>
      )}

      {activePage && activePage.suppressedCount > 0 && (
        <div className="wallet-card p-2 mb-3 text-xs wallet-muted shrink-0">
          Suppressed {activePage.suppressedCount} repetitive post
          {activePage.suppressedCount === 1 ? '' : 's'} on this page.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <div className="space-y-3">
          {rowsToRender.map((row) => {
            const profile = row.actorAddress
              ? profilesByAddress.get(row.actorAddress)
              : undefined;
            const display = profile?.name || row.actorAddress || 'Unknown author';

            return (
              <article key={row.id} className="wallet-card p-4 rounded">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">{display}</div>
                  <div className="wallet-muted text-xs">{actionLabel(row.action)}</div>
                </div>
                <div className="wallet-muted text-xs mt-1 break-all">{row.txid}</div>
                <div className="mt-2 whitespace-pre-wrap break-words">
                  {excerpt(row.action) || (
                    <span className="wallet-muted">No text payload</span>
                  )}
                </div>

                {row.action.type === 'post_topic' && (
                  <div className="mt-2 text-xs wallet-muted">
                    Topic: <span className="font-mono">{row.action.topic}</span>
                  </div>
                )}

                {(row.action.type === 'post' || row.action.type === 'post_topic') && (
                  <div className="mt-3 border-t border-[var(--wallet-border)] pt-2">
                    <div className="text-xs wallet-muted mb-1">Replies</div>
                    <div className="space-y-2">
                      {replies
                        .filter(
                          (r) =>
                            r.action.type === 'reply' &&
                            isReplyTo(row.txid, r.action)
                        )
                        .map((reply) => {
                          if (reply.action.type !== 'reply') return null;
                          const replyProfile = reply.actorAddress
                            ? profilesByAddress.get(reply.actorAddress)
                            : undefined;
                          const replyDisplay =
                            replyProfile?.name || reply.actorAddress || 'Unknown';

                          return (
                            <div
                              key={reply.id}
                              className="wallet-surface-strong rounded p-2"
                            >
                              <div className="text-xs wallet-muted">{replyDisplay}</div>
                              <div className="text-sm whitespace-pre-wrap break-words">
                                {reply.action.message}
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      <div className="wallet-card mt-3 p-3 flex items-center justify-between gap-2 shrink-0">
        <button
          onClick={handleFirstPage}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={loading || currentPage === 1}
        >
          First
        </button>
        <button
          onClick={handlePreviousPage}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={loading || currentPage === 1}
        >
          {'<'}
        </button>
        <div className="py-2 text-sm wallet-text-strong min-w-[70px] text-center">
          {pages.length === 0 ? '0/0' : `${currentPage}/${pages.length}`}
        </div>
        <button
          onClick={() => void handleNextPage()}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={
            loading ||
            pages.length === 0 ||
            (currentPage === pages.length && !pages[pages.length - 1]?.hasMore)
          }
        >
          {'>'}
        </button>
        <button
          onClick={handleLastLoadedPage}
          className="wallet-btn-secondary py-2 px-3 text-sm font-bold"
          disabled={loading || pages.length === 0 || currentPage === pages.length}
        >
          Last
        </button>
      </div>

      {loading && (
        <div className="wallet-muted text-sm py-2 shrink-0">
          {queryingLabel || 'Querying Chaingraph...'}
        </div>
      )}
    </div>
  );
}

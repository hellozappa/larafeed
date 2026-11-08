import {
    type InfiniteData,
    infiniteQueryOptions,
    type QueryClient,
    queryOptions,
} from '@tanstack/react-query';
import type {
    ReaderCounts,
    ReaderEntry,
    ReaderEntryListInput,
    ReaderEntryPage,
    ReaderInteraction,
    ReaderSubscriptionList,
} from '../api/reader';
import {
    fetchReaderJson,
    type ReaderJsonResponse,
    readerEntryListPath,
} from '../api/readerRequest';
import { protectedQueryKeys } from './auth';

export const readerKeys = {
    all: [...protectedQueryKeys.all, 'reader'] as const,
    counts: () => [...readerKeys.all, 'counts'] as const,
};

export const categoryKeys = {
    all: [...readerKeys.all, 'categories'] as const,
    lists: () => [...categoryKeys.all, 'list'] as const,
    list: () => [...categoryKeys.lists(), 'all'] as const,
};

export const subscriptionKeys = {
    all: [...readerKeys.all, 'subscriptions'] as const,
    lists: () => [...subscriptionKeys.all, 'list'] as const,
    list: () => [...subscriptionKeys.lists(), 'all'] as const,
};

export const entryKeys = {
    all: [...readerKeys.all, 'entries'] as const,
    lists: () => [...entryKeys.all, 'infinite-list'] as const,
    list: (scope: ReaderEntryListScope) =>
        [...entryKeys.lists(), scope] as const,
    details: () => [...entryKeys.all, 'detail'] as const,
    detail: (entryId: number) => [...entryKeys.details(), entryId] as const,
    interactions: () => [...entryKeys.all, 'interaction'] as const,
    interaction: (entryId: number, kind: 'read' | 'star' | 'archive') =>
        [...entryKeys.interactions(), entryId, kind] as const,
};

type ReaderDecoders = typeof import('../api/readerDecoders');
type ReaderDecoder<A> = (response: ReaderJsonResponse) => Promise<A>;

function fetchAndDecode<A>(
    path: string,
    signal: AbortSignal,
    selectDecoder: (decoders: ReaderDecoders) => ReaderDecoder<A>,
): Promise<A> {
    // Start the request before importing Effect Schema. Network and decoder
    // loading now overlap instead of forming a route-load waterfall.
    const response = fetchReaderJson(path, signal);
    const decoders = import('../api/readerDecoders');

    return Promise.all([response, decoders]).then(([result, loaded]) =>
        selectDecoder(loaded)(result),
    );
}

export const categoryListQueryOptions = queryOptions({
    queryKey: categoryKeys.list(),
    queryFn: ({ signal }) =>
        fetchAndDecode(
            '/api/categories',
            signal,
            (decoders) => decoders.decodeReaderCategoryList,
        ),
    staleTime: 30_000,
    retry: false,
});

export const subscriptionListQueryOptions = queryOptions({
    queryKey: subscriptionKeys.list(),
    queryFn: ({ signal }) =>
        fetchAndDecode(
            '/api/subscriptions',
            signal,
            (decoders) => decoders.decodeReaderSubscriptionList,
        ),
    staleTime: 20_000,
    retry: false,
});

export const readerCountsQueryOptions = queryOptions({
    queryKey: readerKeys.counts(),
    queryFn: ({ signal }) =>
        fetchAndDecode(
            '/api/entries/counts',
            signal,
            (decoders) => decoders.decodeReaderCounts,
        ),
    staleTime: 15_000,
    retry: false,
});

export type ReaderEntryListScope = Omit<ReaderEntryListInput, 'cursor'>;

export function entryListInfiniteQueryOptions(scope: ReaderEntryListScope) {
    return infiniteQueryOptions({
        queryKey: entryKeys.list(scope),
        queryFn: ({ pageParam, signal }) =>
            fetchAndDecode(
                readerEntryListPath({ ...scope, cursor: pageParam }),
                signal,
                (decoders) => decoders.decodeReaderEntryPage,
            ),
        initialPageParam: null as string | null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        staleTime: 20_000,
        // A focus refetch replays every loaded page sequentially; entry
        // interactions already patch this cache surgically.
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function entryDetailQueryOptions(entryId: number) {
    return queryOptions({
        queryKey: entryKeys.detail(entryId),
        queryFn: ({ signal }) =>
            fetchAndDecode(
                `/api/entries/${entryId}`,
                signal,
                (decoders) => decoders.decodeReaderEntry,
            ),
        staleTime: 30_000,
        retry: false,
    });
}

function patchEntry<A extends ReaderEntryPage['entries'][number]>(
    entry: A,
    interaction: ReaderInteraction,
): A {
    if (entry.id !== interaction.entryId) {
        return entry;
    }

    return {
        ...entry,
        read: interaction.read,
        starred: interaction.starred,
        archived: interaction.archived,
    };
}

// A new network result starts a new baseline. Local counter patches retain
// the original baseline so simultaneous changes to different entries can add up.
const counterBaselines = new WeakMap<object, object>();
const baseline = (value: object) => counterBaselines.get(value) ?? value;
type CachedEntry = Pick<ReaderEntry, 'id' | 'feedId' | 'read' | 'starred'>;
export interface ReaderCounterSnapshot {
    readonly entry?: CachedEntry;
    readonly counts?: object;
    readonly subscriptions?: object;
}
interface ReconciledCounters {
    readonly counts: boolean;
    readonly subscriptions: boolean;
}
const settledData = <T extends object>(
    client: QueryClient,
    key: readonly unknown[],
): T | undefined => {
    const state = client.getQueryState<T>(key);
    return state?.fetchStatus === 'idle' && !state.isInvalidated
        ? state.data
        : undefined;
};
const cachedEntry = (
    client: QueryClient,
    entryId: number,
): CachedEntry | undefined =>
    client.getQueryData<ReaderEntry>(entryKeys.detail(entryId)) ??
    client
        .getQueriesData<InfiniteData<ReaderEntryPage>>({
            queryKey: entryKeys.lists(),
        })
        .flatMap(
            ([, data]) => data?.pages.flatMap((page) => page.entries) ?? [],
        )
        .find((entry) => entry.id === entryId);

export function captureReaderCounterSnapshot(
    client: QueryClient,
    entryId: number,
): ReaderCounterSnapshot {
    const entry = cachedEntry(client, entryId);
    const counts = settledData<ReaderCounts>(client, readerKeys.counts());
    const subscriptions = settledData<ReaderSubscriptionList>(
        client,
        subscriptionKeys.list(),
    );
    return {
        entry:
            entry === undefined
                ? undefined
                : {
                      id: entry.id,
                      feedId: entry.feedId,
                      read: entry.read,
                      starred: entry.starred,
                  },
        counts: counts && baseline(counts),
        subscriptions: subscriptions && baseline(subscriptions),
    };
}

const reconcileCounters = (
    client: QueryClient,
    interaction: ReaderInteraction,
    snapshot?: ReaderCounterSnapshot,
): ReconciledCounters => {
    const before = snapshot?.entry;
    const current = cachedEntry(client, interaction.entryId);
    if (
        before === undefined ||
        current === undefined ||
        before.id !== interaction.entryId ||
        before.feedId !== interaction.feedId ||
        current.feedId !== before.feedId ||
        current.read !== before.read ||
        current.starred !== before.starred
    ) {
        return { counts: false, subscriptions: false };
    }
    const readDelta = Number(interaction.read) - Number(before.read);
    const starDelta = Number(interaction.starred) - Number(before.starred);
    const counts = settledData<ReaderCounts>(client, readerKeys.counts());
    const subscriptions = settledData<ReaderSubscriptionList>(
        client,
        subscriptionKeys.list(),
    );
    let countsPatched = false;
    let subscriptionsPatched = false;
    if (counts && baseline(counts) === snapshot?.counts) {
        const next = {
            ...counts,
            read: counts.read + readDelta,
            unread: counts.unread - readDelta,
            starred: counts.starred + starDelta,
        };
        if (
            Object.values(next).every(
                (value) => Number.isSafeInteger(value) && value >= 0,
            ) &&
            next.read + next.unread === next.total &&
            next.starred <= next.total
        ) {
            const saved = client.setQueryData(readerKeys.counts(), next, {
                updatedAt: client.getQueryState(readerKeys.counts())
                    ?.dataUpdatedAt,
            });
            if (saved) counterBaselines.set(saved, baseline(counts));
            countsPatched = true;
        }
    }
    if (subscriptions && baseline(subscriptions) === snapshot?.subscriptions) {
        const feed = subscriptions.subscriptions.find(
            (feed) => feed.feedId === interaction.feedId,
        );
        const unread = feed === undefined ? -1 : feed.unreadCount - readDelta;
        if (
            feed &&
            Number.isSafeInteger(unread) &&
            unread >= 0 &&
            unread <= feed.totalCount
        ) {
            const next = {
                ...subscriptions,
                subscriptions: subscriptions.subscriptions.map((row) =>
                    row.feedId === interaction.feedId
                        ? { ...row, unreadCount: unread }
                        : row,
                ),
            };
            const saved = client.setQueryData(subscriptionKeys.list(), next, {
                updatedAt: client.getQueryState(subscriptionKeys.list())
                    ?.dataUpdatedAt,
            });
            if (saved) counterBaselines.set(saved, baseline(subscriptions));
            subscriptionsPatched = true;
        }
    }
    return { counts: countsPatched, subscriptions: subscriptionsPatched };
};

export function reconcileReaderInteraction(
    queryClient: QueryClient,
    interaction: ReaderInteraction,
    snapshot?: ReaderCounterSnapshot,
): ReconciledCounters {
    const counters = reconcileCounters(queryClient, interaction, snapshot);
    queryClient.setQueryData<ReaderEntry>(
        entryKeys.detail(interaction.entryId),
        (current) =>
            current === undefined
                ? current
                : {
                      ...current,
                      read: interaction.read,
                      readChangedAt: interaction.readChangedAt,
                      starred: interaction.starred,
                      starredAt: interaction.starredAt,
                      archived: interaction.archived,
                      archivedAt: interaction.archivedAt,
                  },
    );

    queryClient.setQueriesData<InfiniteData<ReaderEntryPage>>(
        { queryKey: entryKeys.lists() },
        (current) =>
            current === undefined
                ? current
                : {
                      ...current,
                      pages: current.pages.map((page) => ({
                          ...page,
                          entries: page.entries.map((entry) =>
                              patchEntry(entry, interaction),
                          ),
                      })),
                  },
    );
    return counters;
}

export async function invalidateReaderAfterInteraction(
    queryClient: QueryClient,
    reconciled: ReconciledCounters = { counts: false, subscriptions: false },
): Promise<void> {
    await Promise.all([
        // The authoritative interaction response already patches all retained
        // pages. Keeping them fresh avoids removing the selected unread or
        // favorite entry while the user reads through the current page.
        ...(!reconciled.counts
            ? [queryClient.invalidateQueries({ queryKey: readerKeys.counts() })]
            : []),
        ...(!reconciled.subscriptions
            ? [
                  queryClient.invalidateQueries({
                      queryKey: subscriptionKeys.lists(),
                  }),
              ]
            : []),
    ]);
}

export async function invalidateReaderAfterReadThrough(
    queryClient: QueryClient,
): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: entryKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: readerKeys.counts() }),
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.lists() }),
    ]);
}

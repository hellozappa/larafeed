import {
    type InfiniteData,
    MutationObserver,
    QueryClient,
    QueryObserver,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ReaderEntry,
    ReaderEntryPage,
    ReaderInteraction,
} from '../api/reader';
import {
    captureReaderCounterSnapshot,
    categoryKeys,
    categoryListQueryOptions,
    entryKeys,
    entryListInfiniteQueryOptions,
    invalidateReaderAfterInteraction,
    type ReaderEntryListScope,
    readerKeys,
    reconcileReaderInteraction,
    subscriptionKeys,
} from './reader';
import {
    entryReadMutationOptions,
    entryStarMutationOptions,
} from './readerMutations';

const listScope: ReaderEntryListScope = {
    feedId: 3,
    categoryId: null,
    filter: 'unread',
    orderBy: 'published_at',
    pageSize: 30,
};

const detail: ReaderEntry = {
    id: 7,
    feedId: 3,
    title: 'A stable entry',
    url: 'https://example.com/entry',
    author: 'Author',
    publishedAt: 1_900_000_000_000,
    createdAt: 1_900_000_000_100,
    feedName: 'Example feed',
    customFeedName: null,
    faviconUrl: null,
    faviconIsDark: null,
    read: false,
    starred: false,
    archived: false,
    contentHtml: '<p>Content</p>',
    readChangedAt: null,
    starredAt: null,
    archivedAt: null,
};

const page: ReaderEntryPage = {
    entries: [
        {
            id: detail.id,
            feedId: detail.feedId,
            title: detail.title,
            url: detail.url,
            author: detail.author,
            publishedAt: detail.publishedAt,
            createdAt: detail.createdAt,
            feedName: detail.feedName,
            customFeedName: detail.customFeedName,
            faviconUrl: detail.faviconUrl,
            faviconIsDark: detail.faviconIsDark,
            read: detail.read,
            starred: detail.starred,
            archived: detail.archived,
        },
    ],
    total: 31,
    nextCursor: '1900000000000:7',
};

const infinitePage: InfiniteData<ReaderEntryPage> = {
    pages: [page],
    pageParams: [null],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

const interaction: ReaderInteraction = {
    entryId: 7,
    feedId: 3,
    read: true,
    readChangedAt: 1_900_000_001_000,
    starred: true,
    starredAt: 1_900_000_001_000,
    archived: false,
    archivedAt: null,
};

describe('reader query contracts', () => {
    it('starts the request immediately and decodes when it completes', async () => {
        let resolveResponse: ((response: Response) => void) | undefined;
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });

        const result = queryClient.fetchQuery(categoryListQueryOptions);
        expect(fetchMock).toHaveBeenCalledOnce();

        resolveResponse?.(Response.json({ categories: [] }));
        await expect(result).resolves.toEqual({ categories: [] });
    });

    it('includes the whole list scope in a hierarchical key', () => {
        expect(entryKeys.list(listScope)).toEqual([
            'protected',
            'reader',
            'entries',
            'infinite-list',
            listScope,
        ]);
        expect(entryKeys.detail(7)).toEqual([
            'protected',
            'reader',
            'entries',
            'detail',
            7,
        ]);
        expect(entryListInfiniteQueryOptions(listScope).queryKey).toEqual(
            entryKeys.list(listScope),
        );
    });

    it('follows the server cursor until the last page is loaded', () => {
        const options = entryListInfiniteQueryOptions(listScope);
        expect(options.initialPageParam).toBeNull();
        expect(options.getNextPageParam(page, [page], null, [null])).toBe(
            '1900000000000:7',
        );

        const lastPage: ReaderEntryPage = { ...page, nextCursor: null };
        expect(
            options.getNextPageParam(
                lastPage,
                [page, lastPage],
                '1900000000000:7',
                [null, '1900000000000:7'],
            ),
        ).toBeUndefined();
    });

    it('patches retained detail and list data from authoritative results', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData<ReaderEntry>(entryKeys.detail(7), detail);
        queryClient.setQueryData<InfiniteData<ReaderEntryPage>>(
            entryKeys.list(listScope),
            infinitePage,
        );

        reconcileReaderInteraction(queryClient, interaction);

        expect(queryClient.getQueryData(entryKeys.detail(7))).toMatchObject({
            read: true,
            readChangedAt: interaction.readChangedAt,
            starred: true,
            starredAt: interaction.starredAt,
            archived: false,
        });
        expect(
            queryClient.getQueryData(entryKeys.list(listScope)),
        ).toMatchObject({
            pages: [
                {
                    entries: [
                        {
                            id: 7,
                            read: true,
                            starred: true,
                            archived: false,
                        },
                    ],
                },
            ],
        });
    });

    it('keeps retained lists stable while invalidating counts', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const queryFn = vi.fn(() => Promise.resolve(page));
        const observer = new QueryObserver(queryClient, {
            queryKey: entryKeys.list(listScope),
            queryFn,
        });
        const unsubscribe = observer.subscribe(() => undefined);
        await observer.refetch();
        queryClient.setQueryData(readerKeys.counts(), { total: 1 });
        queryClient.setQueryData(subscriptionKeys.list(), {
            subscriptions: [],
        });
        queryClient.setQueryData(categoryKeys.list(), { categories: [] });

        await invalidateReaderAfterInteraction(queryClient);

        expect(queryFn).toHaveBeenCalledTimes(1);
        expect(observer.getCurrentResult().data).toEqual(page);
        expect(
            queryClient.getQueryState(entryKeys.list(listScope))?.isInvalidated,
        ).toBe(false);
        expect(
            queryClient.getQueryState(readerKeys.counts())?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(subscriptionKeys.list())?.isInvalidated,
        ).toBe(true);
        expect(
            queryClient.getQueryState(categoryKeys.list())?.isInvalidated,
        ).toBe(false);
        unsubscribe();
    });

    it('serializes all interaction kinds for the same entry', () => {
        const queryClient = new QueryClient();
        const readOptions = entryReadMutationOptions(queryClient, 7);
        const starOptions = entryStarMutationOptions(queryClient, 7);
        const anotherEntry = entryReadMutationOptions(queryClient, 8);

        expect(readOptions.scope).toEqual({ id: 'reader-entry-7' });
        expect(starOptions.scope).toEqual(readOptions.scope);
        expect(anotherEntry.scope).toEqual({ id: 'reader-entry-8' });
        expect(readOptions.retry).toBe(false);
    });
});

describe('reader counter reconciliation', () => {
    const seed = () => {
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        client.setQueryData(entryKeys.detail(7), detail);
        client.setQueryData(
            readerKeys.counts(),
            { total: 2, read: 0, unread: 2, starred: 0 },
            { updatedAt: 100 },
        );
        client.setQueryData(
            subscriptionKeys.list(),
            { subscriptions: [{ feedId: 3, totalCount: 2, unreadCount: 2 }] },
            { updatedAt: 100 },
        );
        return client;
    };

    it('does not request counter endpoints after a successful read mutation with known baselines', async () => {
        vi.stubGlobal('document', { cookie: 'larafeed-csrf=csrf-token' });
        const fetch = vi.fn(() => Promise.resolve(Response.json(interaction)));
        vi.stubGlobal('fetch', fetch);
        const client = seed();
        const observer = new MutationObserver(
            client,
            entryReadMutationOptions(client, 7),
        );
        await observer.mutate(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(client.getQueryData(readerKeys.counts())).toMatchObject({
            read: 1,
            unread: 1,
            starred: 1,
        });
        expect(client.getQueryState(readerKeys.counts())?.isInvalidated).toBe(
            false,
        );
    });

    it('updates known counters without rescanning and preserves their refresh age', async () => {
        const client = seed();
        const snapshot = captureReaderCounterSnapshot(client, 7);
        const patched = reconcileReaderInteraction(
            client,
            interaction,
            snapshot,
        );
        await invalidateReaderAfterInteraction(client, patched);
        expect(client.getQueryData(readerKeys.counts())).toEqual({
            total: 2,
            read: 1,
            unread: 1,
            starred: 1,
        });
        expect(client.getQueryData(subscriptionKeys.list())).toMatchObject({
            subscriptions: [{ unreadCount: 1 }],
        });
        expect(client.getQueryState(readerKeys.counts())?.isInvalidated).toBe(
            false,
        );
        expect(
            client.getQueryState(subscriptionKeys.list())?.isInvalidated,
        ).toBe(false);
        expect(client.getQueryState(readerKeys.counts())?.dataUpdatedAt).toBe(
            100,
        );
        const noOp = reconcileReaderInteraction(
            client,
            interaction,
            captureReaderCounterSnapshot(client, 7),
        );
        expect(noOp).toEqual({ counts: true, subscriptions: true });
        expect(client.getQueryData(readerKeys.counts())).toMatchObject({
            read: 1,
            starred: 1,
        });
    });

    it('combines overlapping changes to different articles from the same counter baseline', () => {
        const client = seed();
        client.setQueryData(entryKeys.detail(8), { ...detail, id: 8 });
        const first = captureReaderCounterSnapshot(client, 7);
        const second = captureReaderCounterSnapshot(client, 8);
        expect(reconcileReaderInteraction(client, interaction, first)).toEqual({
            counts: true,
            subscriptions: true,
        });
        expect(
            reconcileReaderInteraction(
                client,
                { ...interaction, entryId: 8, starred: false, starredAt: null },
                second,
            ),
        ).toEqual({ counts: true, subscriptions: true });
        expect(client.getQueryData(readerKeys.counts())).toEqual({
            total: 2,
            read: 2,
            unread: 0,
            starred: 1,
        });
        expect(client.getQueryData(subscriptionKeys.list())).toMatchObject({
            subscriptions: [{ unreadCount: 0 }],
        });
    });

    it('refetches counters that received a new baseline during the mutation', async () => {
        const client = seed();
        const snapshot = captureReaderCounterSnapshot(client, 7);
        client.setQueryData(readerKeys.counts(), {
            total: 3,
            read: 1,
            unread: 2,
            starred: 0,
        });
        const patched = reconcileReaderInteraction(
            client,
            interaction,
            snapshot,
        );
        expect(patched.counts).toBe(false);
        await invalidateReaderAfterInteraction(client, patched);
        expect(client.getQueryData(readerKeys.counts())).toEqual({
            total: 3,
            read: 1,
            unread: 2,
            starred: 0,
        });
        expect(client.getQueryState(readerKeys.counts())?.isInvalidated).toBe(
            true,
        );
    });

    it('handles unread, unstar and archive results without changing total article counts', () => {
        const client = seed();
        client.setQueryData(entryKeys.detail(7), {
            ...detail,
            read: true,
            starred: true,
        });
        client.setQueryData(readerKeys.counts(), {
            total: 2,
            read: 1,
            unread: 1,
            starred: 1,
        });
        client.setQueryData(subscriptionKeys.list(), {
            subscriptions: [{ feedId: 3, totalCount: 2, unreadCount: 1 }],
        });
        reconcileReaderInteraction(
            client,
            {
                ...interaction,
                read: false,
                starred: false,
                starredAt: null,
                archived: true,
                archivedAt: 1_900_000_002_000,
            },
            captureReaderCounterSnapshot(client, 7),
        );
        expect(client.getQueryData(readerKeys.counts())).toEqual({
            total: 2,
            read: 0,
            unread: 2,
            starred: 0,
        });
        expect(client.getQueryData(subscriptionKeys.list())).toMatchObject({
            subscriptions: [{ totalCount: 2, unreadCount: 2 }],
        });
    });

    it('does not patch counters while an authoritative request is in flight', async () => {
        const client = seed();
        let resolve:
            | ((value: {
                  total: number;
                  read: number;
                  unread: number;
                  starred: number;
              }) => void)
            | undefined;
        const request = client.fetchQuery({
            queryKey: readerKeys.counts(),
            queryFn: () =>
                new Promise<{
                    total: number;
                    read: number;
                    unread: number;
                    starred: number;
                }>((done) => {
                    resolve = done;
                }),
        });
        const snapshot = captureReaderCounterSnapshot(client, 7);
        const patched = reconcileReaderInteraction(
            client,
            interaction,
            snapshot,
        );
        expect(patched.counts).toBe(false);
        resolve?.({ total: 2, read: 1, unread: 1, starred: 1 });
        await request;
        expect(client.getQueryData(readerKeys.counts())).toEqual({
            total: 2,
            read: 1,
            unread: 1,
            starred: 1,
        });
    });

    it('refetches when article state changed or cached counts are missing', async () => {
        const client = seed();
        const snapshot = captureReaderCounterSnapshot(client, 7);
        client.setQueryData(entryKeys.detail(7), { ...detail, read: true });
        const patched = reconcileReaderInteraction(
            client,
            interaction,
            snapshot,
        );
        expect(patched).toEqual({ counts: false, subscriptions: false });
        await invalidateReaderAfterInteraction(client, patched);
        expect(client.getQueryState(readerKeys.counts())?.isInvalidated).toBe(
            true,
        );
        const empty = new QueryClient();
        expect(
            reconcileReaderInteraction(
                empty,
                interaction,
                captureReaderCounterSnapshot(empty, 7),
            ),
        ).toEqual({ counts: false, subscriptions: false });
    });
});

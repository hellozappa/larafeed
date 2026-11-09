import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ReaderEntry } from '../../api/reader';
import type { EntrySummaryResult } from '../../api/summaries';
import { fullContentKeys } from '../../queries/fullContent';
import { subscriptionManagementKeys } from '../../queries/subscriptions';
import { ReaderEntryDetail } from './ReaderEntryDetail';

const entry: ReaderEntry = {
    id: 31,
    feedId: 21,
    title: 'Article',
    url: 'https://example.test/article',
    author: 'Author',
    publishedAt: 1_900_000_000_000,
    createdAt: 1_900_000_000_100,
    feedName: 'Feed',
    customFeedName: null,
    faviconUrl: null,
    faviconIsDark: null,
    read: true,
    starred: false,
    archived: false,
    contentHtml: '<p>Article content.</p>',
    readChangedAt: 1_900_000_000_200,
    starredAt: null,
    archivedAt: null,
};

const managedSubscription = {
    feedId: entry.feedId,
    categoryId: 1,
    categoryName: 'Technology',
    feedName: entry.feedName,
    customFeedName: null,
    feedUrl: 'https://example.test/feed.xml',
    siteUrl: 'https://example.test/',
    faviconUrl: null,
    faviconIsDark: null,
    entryCount: 1,
    unreadCount: 0,
    isGone: false,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastSuccessfulRefreshAt: null,
    lastFailedRefreshAt: null,
    lastErrorClass: null,
    lastErrorMessage: null,
    filterRules: {
        excludeTitle: [],
        excludeContent: [],
        excludeAuthor: [],
    },
    refreshes: [],
};

const renderDetail = (
    summary?: EntrySummaryResult,
    summarize = false,
): string => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(fullContentKeys.detail(entry.id), {
        fullContent: {
            entryId: entry.id,
            html: '<p>Full article content.</p>',
            sourceUrl: entry.url,
            fetchedAt: 1_900_000_000_000,
            summary: summary?.summary ?? null,
        },
    });
    queryClient.setQueryData(subscriptionManagementKeys.list(), {
        categories: [{ id: 1, name: 'Technology', subscriptionCount: 1 }],
        subscriptions: [managedSubscription],
    });

    return renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
            <MantineProvider>
                <ReaderEntryDetail
                    archivePending={false}
                    entry={entry}
                    error={null}
                    isFetching={false}
                    isPending={false}
                    mutationError={null}
                    onBack={() => undefined}
                    onRetry={() => undefined}
                    onSetArchived={() => undefined}
                    onSetRead={() => undefined}
                    onSetStarred={() => undefined}
                    onSetSummarize={() => undefined}
                    readPending={false}
                    selected
                    starPending={false}
                    summarize={summarize}
                />
            </MantineProvider>
        </QueryClientProvider>,
    );
};

it.each(['fresh', 'legacy', 'blocked'] as const)(
    'opens full articles across feeds without clicks with %s storage',
    async (storage) => {
        const { window } = parseHTML(
            '<!doctype html><html><body></body></html>',
        );
        window.HTMLElement.prototype.scrollTo = vi.fn();
        const getItem = vi.fn(() => {
            if (storage === 'blocked') throw new Error('Storage is blocked');
            return storage === 'legacy' ? 'false' : null;
        });
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            value: { getItem },
        });
        window.document.cookie = 'larafeed-csrf=token';
        vi.stubGlobal('window', window);
        vi.stubGlobal('document', window.document);
        vi.stubGlobal('Element', window.Element);
        vi.stubGlobal('HTMLElement', window.HTMLElement);
        vi.stubGlobal(
            'requestAnimationFrame',
            (callback: FrameRequestCallback) =>
                setTimeout(() => callback(performance.now()), 0),
        );
        vi.stubGlobal('cancelAnimationFrame', clearTimeout);
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
        const fetch = vi.fn((url: string, init?: RequestInit) => {
            const id = Number(url.match(/entries\/(\d+)/)?.[1]);
            return Promise.resolve(
                Response.json({
                    fullContent:
                        init?.method === 'POST'
                            ? {
                                  entryId: id,
                                  html: `<p>Full text ${id}</p>`,
                                  sourceUrl: entry.url,
                                  fetchedAt: 1_900_000_000_000,
                                  summary: null,
                              }
                            : null,
                }),
            );
        });
        vi.stubGlobal('fetch', fetch);
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        client.setQueryData(subscriptionManagementKeys.list(), {
            categories: [],
            subscriptions: [managedSubscription],
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const render = (id: number) =>
            root.render(
                <QueryClientProvider client={client}>
                    <MantineProvider env="test">
                        <ReaderEntryDetail
                            archivePending={false}
                            entry={{
                                ...entry,
                                id,
                                feedId: id === 33 ? 22 : 21,
                            }}
                            error={null}
                            isFetching={false}
                            isPending={false}
                            mutationError={null}
                            onBack={() => undefined}
                            onRetry={() => undefined}
                            onSetArchived={() => undefined}
                            onSetRead={() => undefined}
                            onSetStarred={() => undefined}
                            onSetSummarize={() => undefined}
                            readPending={false}
                            selected
                            starPending={false}
                            summarize={false}
                        />
                    </MantineProvider>
                </QueryClientProvider>,
            );
        try {
            for (const id of [31, 32, 33, 31]) {
                await act(() => render(id));
                await act(async () => {
                    await vi.waitFor(() =>
                        expect(container.textContent).toContain(
                            `Full text ${id}`,
                        ),
                    );
                });
                if (id === 31) {
                    await act(() =>
                        container
                            .querySelector(
                                '[aria-label="Show the feed version"]',
                            )
                            ?.dispatchEvent(
                                new window.Event('click', { bubbles: true }),
                            ),
                    );
                    expect(container.textContent).toContain('Article content.');
                    expect(container.textContent).not.toContain('Full text 31');
                }
            }
            expect(
                fetch.mock.calls
                    .filter(([, init]) => init?.method === 'POST')
                    .map(([url]) => url),
            ).toEqual([
                '/api/entries/31/full-content',
                '/api/entries/32/full-content',
                '/api/entries/33/full-content',
            ]);
            expect(getItem).not.toHaveBeenCalledWith(
                expect.stringMatching(/^larafeed-feed-/),
            );
        } finally {
            await act(() => root.unmount());
            client.clear();
            vi.unstubAllGlobals();
        }
    },
);

describe('ReaderEntryDetail summaries', () => {
    it('renders cached sanitized summary HTML without regeneration', () => {
        const markup = renderDetail(
            {
                summary: {
                    id: 41,
                    entryId: entry.id,
                    html: '<p><strong>Cached summary.</strong></p>',
                    model: 'gemini-2.5-flash',
                    promptVersion: 'entry-summary-v1',
                    generatedAt: 1_900_000_000_000,
                },
            },
            true,
        );
        expect(markup).not.toContain('aria-label="Entry view"');
        expect(markup).toContain(
            'aria-label="Open original article in a new tab"',
        );
        expect(markup).not.toContain('Original');
        expect(markup).toContain('aria-label="More entry and feed actions"');
        expect(markup).toContain('Back to article');
        expect(markup).toContain('AI Summary');
        expect(markup).toContain('less than a minute read');
        expect(markup).toContain(
            'Estimated reading time at 300 words per minute',
        );
        expect(markup).toContain('<strong>Cached summary.</strong>');
        expect(markup).not.toContain('Generate summary');
    });

    it('does not mount summary content while article mode is active', () => {
        const markup = renderDetail({
            summary: {
                id: 41,
                entryId: entry.id,
                html: '<p>Must stay inactive.</p>',
                model: 'gemini-2.5-flash',
                promptVersion: 'entry-summary-v1',
                generatedAt: 1_900_000_000_000,
            },
        });
        expect(markup).toContain('Full article content.');
        expect(markup).not.toContain('Back to article');
        expect(markup).not.toContain('Must stay inactive.');
        expect(markup).not.toContain('Loading summary');
    });

    it('shows a skeleton immediately while loading or starting generation', () => {
        expect(renderDetail(undefined, true)).toContain('Loading summary');
        const missing = renderDetail({ summary: null }, true);
        expect(missing).toContain('Loading summary');
        expect(missing).not.toContain('Generate summary');
    });

    it('keeps mobile navigation and a stable detail focus target', () => {
        const markup = renderDetail();

        expect(markup).toContain('aria-label="Back to entry list"');
        expect(markup).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Article<\/h1>/u);
    });

    it('starts with full content and offers the feed version in the toolbar', () => {
        const markup = renderDetail();

        expect(markup).toContain('aria-label="Show the feed version"');
        expect(markup).not.toContain('Read the full article');
    });
});

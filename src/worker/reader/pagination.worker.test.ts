import { env } from 'cloudflare:workers';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

import { type D1, type D1Statement, makeD1 } from '../infrastructure/d1';
import { makeReaderRepository, type ReaderEntryQuery } from './repository';

const d1 = makeD1(env.DB);
const pages: { statement: D1Statement; reads: number }[] = [];
const measured: D1 = {
    ...d1,
    batch: <T>(statements: readonly D1Statement[]) =>
        d1.batch<T>(statements).pipe(
            Effect.map((results) => {
                statements.forEach((statement, index) => {
                    if (statement.sql.includes('ORDER BY'))
                        pages.push({
                            statement,
                            reads: results[index].meta.rows_read,
                        });
                });
                return results;
            }),
        ),
};
const repository = makeReaderRepository(measured);
const query: ReaderEntryQuery = {
    scope: { type: 'all' },
    filter: 'all',
    orderBy: 'published_at',
    cursor: null,
    pageSize: 20,
};

beforeAll(async () => {
    const now = 1_800_000_000_000;
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO users(id,webauthn_user_handle,username,email,display_name,created_at,updated_at) VALUES (1,zeroblob(32),'reader','reader@example.test','Reader',?,?)`,
        ).bind(now, now),
        env.DB.prepare(
            `INSERT INTO users(id,webauthn_user_handle,username,email,display_name,created_at,updated_at) VALUES (2,randomblob(32),'selective','selective@example.test','Selective',?,?)`,
        ).bind(now, now),
        env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<184)
            INSERT INTO feeds(id,name,feed_url,next_refresh_at,created_at,updated_at) SELECT x,'Feed '||x,'https://publisher.example.test/feed/'||x,?,?,? FROM n`).bind(
            now,
            now,
            now,
        ),
        env.DB.prepare(
            `INSERT INTO subscription_categories(id,user_id,name,created_at,updated_at) VALUES (1,1,'All',?,?),(2,2,'Selective',?,?)`,
        ).bind(now, now, now, now),
        env.DB.prepare(
            `INSERT INTO feed_subscriptions(user_id,feed_id,category_id,created_at,updated_at) SELECT 1,id,1,?,? FROM feeds`,
        ).bind(now, now),
        env.DB.prepare(
            `INSERT INTO feed_subscriptions(user_id,feed_id,category_id,created_at,updated_at) VALUES (2,1,2,?,?)`,
        ).bind(now, now),
        env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<23000)
            INSERT INTO entries(id,feed_id,deduplication_key,title,url,published_at,content_status,created_at,updated_at)
            SELECT x,1+(x%184),unhex(printf('%064x',x)),'Article '||x,'https://publisher.example.test/article/'||x,?+(x/3)*1000,'empty',?+x,?+x FROM n`).bind(
            now,
            now,
            now,
        ),
        env.DB.prepare(
            `INSERT INTO entry_interactions(user_id,feed_id,entry_id,filtered_at,created_at,updated_at) VALUES (1,1+(23000%184),23000,?,?,?)`,
        ).bind(now, now, now),
        env.DB.prepare(
            `INSERT INTO entry_interactions(user_id,feed_id,entry_id,read_override,read_changed_at,starred_at,created_at,updated_at) VALUES (1,1+(22999%184),22999,1,?,?,?,?)`,
        ).bind(now, now, now, now),
    ]);
});

describe('bounded reader page planning', () => {
    it.each(['published_at', 'created_at'] as const)(
        'keeps %s pages ordered and bounded across a cursor',
        async (orderBy) => {
            pages.length = 0;
            const first = await Effect.runPromise(
                repository.listEntries(1, { ...query, orderBy }),
            );
            expect(first.total).toBe(22999);
            expect(first.entries.map((entry) => entry.id)).toEqual(
                Array.from({ length: 20 }, (_, i) => 22999 - i),
            );
            expect(pages.at(-1)?.reads).toBeLessThan(150);
            expect(pages.at(-1)?.statement.sql).toContain('CROSS JOIN');
            const second = await Effect.runPromise(
                repository.listEntries(1, {
                    ...query,
                    orderBy,
                    cursor: first.nextCursor,
                }),
            );
            expect(second.total).toBe(first.total);
            expect(second.entries.map((entry) => entry.id)).toEqual(
                Array.from({ length: 20 }, (_, i) => 22979 - i),
            );
            expect(pages.at(-1)?.reads).toBeLessThan(150);
            const deep = await Effect.runPromise(
                repository.listEntries(1, {
                    ...query,
                    orderBy,
                    cursor: {
                        orderValue:
                            1_800_000_000_000 +
                            (orderBy === 'created_at'
                                ? 1000
                                : Math.floor(1000 / 3) * 1000),
                        id: 1000,
                    },
                }),
            );
            expect(deep.entries.map((entry) => entry.id)).toEqual(
                Array.from({ length: 20 }, (_, i) => 999 - i),
            );
            expect(pages.at(-1)?.reads).toBeLessThan(150);
        },
    );

    it('retains feed-first planning for selective subscriptions and scoped filters', async () => {
        pages.length = 0;
        const selective = await Effect.runPromise(
            repository.listEntries(2, query),
        );
        expect(selective.total).toBe(125);
        expect(selective.entries.every((entry) => entry.feedId === 1)).toBe(
            true,
        );
        expect(pages.at(-1)?.statement.sql).not.toContain('CROSS JOIN');
        expect(pages.at(-1)?.reads).toBeLessThan(600);
        const favorites = await Effect.runPromise(
            repository.listEntries(1, { ...query, filter: 'favorites' }),
        );
        expect(favorites.entries.map((entry) => entry.id)).toEqual([22999]);
        expect(pages.at(-1)?.statement.sql).not.toContain('CROSS JOIN');
        const unread = await Effect.runPromise(
            repository.listEntries(1, {
                ...query,
                scope: { type: 'feed', id: 1 + (22999 % 184) },
                filter: 'unread',
            }),
        );
        expect(unread.entries.some((entry) => entry.id === 22999)).toBe(false);
        const category = await Effect.runPromise(
            repository.listEntries(1, {
                ...query,
                scope: { type: 'category', id: 1 },
            }),
        );
        expect(category.total).toBe(22999);
        expect(pages.at(-1)?.statement.sql).not.toContain('CROSS JOIN');
    });
});

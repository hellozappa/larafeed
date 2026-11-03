import { env } from 'cloudflare:workers';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { type D1, type D1Statement, makeD1 } from '../infrastructure/d1';
import { makeOpmlRepository } from '../opml/repository';
import { makeJobRepository } from './repository';

const d1 = makeD1(env.DB);
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

const observe = () => {
    const measurements: { statement: D1Statement; meta: D1Meta }[] = [];
    const observed: D1 = {
        ...d1,
        batch: <T = unknown>(statements: readonly D1Statement[]) =>
            Effect.map(d1.batch<T>(statements), (results) => {
                results.forEach((result, index) => {
                    const statement = statements[index];
                    if (statement === undefined) {
                        throw new Error('Missing measured D1 statement');
                    }
                    measurements.push({
                        statement,
                        meta: result.meta,
                    });
                });
                return results;
            }),
    };
    return { observed, measurements };
};

const key = (id: number) => {
    const result = new Uint8Array(32);
    new DataView(result.buffer).setUint32(28, id);
    return result;
};

describe('D1 background read costs', () => {
    it('does not scan completed history during idle recovery', async () => {
        const now = 2_200_100_000_000;
        for (let offset = 0; offset < 1_000; offset += 50) {
            await env.DB.batch(
                Array.from({ length: 50 }, (_, index) => {
                    const id = 7_000_000 + offset + index;
                    return env.DB.prepare(
                        `INSERT INTO jobs (
                            id, operation_id, kind, state, payload_json,
                            max_attempts, available_at, completed_at,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, 'succeeded', '{}', 8, ?, ?, ?, ?)`,
                    ).bind(
                        id,
                        `read-cost-${id}`,
                        index % 2 === 0 ? 'feed_refresh' : 'opml_import_feed',
                        now - 1_000,
                        now - 500,
                        now - 1_000,
                        now - 500,
                    );
                }),
            );
        }

        const { observed, measurements } = observe();
        await expect(
            makeJobRepository(observed).recoverStaleJobLeases(now, 50),
        ).resolves.toBe(0);
        await expect(
            makeOpmlRepository(observed).recoverActiveImports(
                now,
                now - 100,
                50,
            ),
        ).resolves.toEqual({ imports: 0, jobs: 0 });

        const reads = measurements.reduce(
            (sum, item) => sum + item.meta.rows_read,
            0,
        );
        const writes = measurements.reduce(
            (sum, item) => sum + item.meta.rows_written,
            0,
        );
        expect(reads).toBeLessThan(100);
        expect(writes).toBe(0);

        const recovery = measurements.filter(({ statement }) =>
            /(?:\w+\.)?last_error_class = '(?:stale_lease|queue_redrive_exhausted|queue_delivery_lost)'/u.test(
                statement.sql.slice(statement.sql.indexOf('WHERE')),
            ),
        );
        expect(recovery).toHaveLength(6);
        for (const { statement } of recovery) {
            const plan = await run(
                d1.all<{ detail: string }>({
                    sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
                    bindings: statement.bindings,
                }),
            );
            expect(
                plan.results.some(({ detail }) =>
                    detail.includes('jobs_recovery_lookup'),
                ),
            ).toBe(true);
            expect(
                plan.results.some(({ detail }) =>
                    /\bSCAN (?:jobs|j)\b/u.test(detail),
                ),
            ).toBe(false);
        }
        console.log(
            JSON.stringify({ scenario: 'idle_recovery', reads, writes }),
        );
    }, 60_000);

    it('bounds unfiltered refresh work to the incoming articles', async () => {
        const now = 2_200_200_000_000;
        const feedId = 7_100_000;
        await run(
            d1.run({
                sql: `INSERT INTO feeds(id,name,feed_url,next_refresh_at,created_at,updated_at)
                VALUES (?, 'Read cost', 'https://read-cost.example.test/feed', ?, ?, ?)`,
                bindings: [feedId, now, now, now],
            }),
        );
        for (let offset = 0; offset < 1_000; offset += 50) {
            await env.DB.batch(
                Array.from({ length: 50 }, (_, index) => {
                    const value = offset + index + 1;
                    return env.DB.prepare(`INSERT INTO entries(
                    id,feed_id,deduplication_key,title,content_status,published_at,created_at,updated_at
                ) VALUES (?, ?, ?, 'Old article', 'empty', ?, ?, ?)`).bind(
                        7_200_000 + value,
                        feedId,
                        key(value),
                        now - 1_000,
                        now - 1_000,
                        now - 1_000,
                    );
                }),
            );
        }
        const { observed, measurements } = observe();
        const repository = makeJobRepository(observed);
        await repository.createRefreshJob({
            jobId: 7_300_000,
            outboxId: 7_300_001,
            operationId: 'read-cost-refresh',
            feedId,
            trigger: 'manual',
            maxAttempts: 3,
            now,
        });
        const claim = await repository.claimRefreshJob({
            operationId: 'read-cost-refresh',
            owner: 'read-cost',
            now,
            leaseMs: 60_000,
        });
        if (claim.type !== 'claimed') throw new Error('Expected refresh claim');
        measurements.length = 0;
        await repository.commitRefresh({
            claim: claim.claim,
            subscriptionFilterRevisions: [],
            historyId: 7_300_002,
            completedAt: now + 1,
            etag: null,
            lastModified: null,
            nextRefreshAt: now + 60_000,
            httpStatus: 200,
            durationMs: 1,
            notModified: false,
            entries: [1_000, 1_001].map((value) => ({
                deduplicationKey: key(value),
                sourceId: null,
                title: 'Changed article',
                url: null,
                author: null,
                publishedAt: now - 1_000,
                sourceUpdatedAt: null,
                updateMask: {
                    title: true,
                    url: true,
                    author: true,
                    publishedAt: true,
                    sourceUpdatedAt: true,
                    content: true,
                },
                filteredUserIds: [],
                content: { type: 'empty' as const },
            })),
        });
        const reads = measurements.reduce(
            (sum, item) => sum + item.meta.rows_read,
            0,
        );
        const writes = measurements.reduce(
            (sum, item) => sum + item.meta.rows_written,
            0,
        );
        expect(reads).toBeLessThan(150);
        expect(
            measurements.some(({ statement }) =>
                statement.sql.includes('INSERT INTO entry_interactions'),
            ),
        ).toBe(false);
        await expect(
            run(
                d1.first({
                    sql: 'SELECT entries_created,entries_updated FROM feed_refreshes WHERE id = ?',
                    bindings: [7_300_002],
                }),
            ),
        ).resolves.toEqual({ entries_created: 1, entries_updated: 1 });
        const count = await env.DB.prepare(
            'SELECT COUNT(*) AS total FROM entries WHERE feed_id = ?',
        )
            .bind(feedId)
            .first<{ total: number }>();
        expect(count?.total).toBe(1_001);
        console.log(
            JSON.stringify({ scenario: 'unfiltered_refresh', reads, writes }),
        );
    }, 60_000);
});

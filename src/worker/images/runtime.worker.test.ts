import { env } from 'cloudflare:workers';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { defaultFullContentRuntimeFactory } from '../fullcontent/routes';
import { makeKvFullContentStore } from '../fullcontent/store';
import { defaultReaderRuntimeFactory } from '../reader/routes';

const now = 1_800_000_000_000;
const sourceUrl = 'https://publisher.example.test/article';
const html =
    '<p><img src="https://media.example.test/photo.avif" alt="Photo"></p>';

describe('image rollout through the default runtimes', () => {
    it('rewrites feed and already-cached full article images only when enabled', async () => {
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO users (id, webauthn_user_handle, username, email, display_name, created_at, updated_at)
                VALUES (1, ?, 'image-reader', 'image-reader@example.test', 'Reader', ?, ?)`).bind(
                new Uint8Array(32).fill(1),
                now,
                now,
            ),
            env.DB.prepare(`INSERT INTO feeds (id, name, feed_url, next_refresh_at, created_at, updated_at)
                VALUES (1, 'Images', 'https://publisher.example.test/feed.xml', ?, ?, ?)`).bind(
                now,
                now,
                now,
            ),
            env.DB.prepare(`INSERT INTO subscription_categories (id, user_id, name, created_at, updated_at)
                VALUES (1, 1, 'Images', ?, ?)`).bind(now, now),
            env.DB.prepare(`INSERT INTO feed_subscriptions (user_id, feed_id, category_id, created_at, updated_at)
                VALUES (1, 1, 1, ?, ?)`).bind(now, now),
            env.DB.prepare(`INSERT INTO entries (id, feed_id, deduplication_key, title, url, published_at, content_status, created_at, updated_at)
                VALUES (1, 1, ?, 'Image article', ?, ?, 'stored', ?, ?)`).bind(
                new Uint8Array(32).fill(2),
                sourceUrl,
                now,
                now,
                now,
            ),
            env.DB.prepare(`INSERT INTO entry_contents (entry_id, content_html, content_hash, encoded_size_bytes, created_at, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)`).bind(
                html,
                new Uint8Array(32).fill(3),
                new TextEncoder().encode(html).byteLength,
                now,
                now,
            ),
        ]);
        const store = makeKvFullContentStore(env.FULL_CONTENT_KV);
        await Effect.runPromise(
            store.save({
                version: 1,
                entryId: 1,
                sourceUrl,
                fetchedAt: now,
                html,
                summary: null,
            }),
        );

        for (const enabled of ['true', 'false']) {
            const bindings = { ...env, IMAGES_ENABLED: enabled };
            const reader = await Effect.runPromise(
                defaultReaderRuntimeFactory(bindings),
            );
            const fullContent = await Effect.runPromise(
                defaultFullContentRuntimeFactory(bindings),
            );
            const feed = await Effect.runPromise(
                reader.service.findEntry(1, 1),
            );
            const full = await Effect.runPromise(fullContent.service.get(1, 1));
            expect(feed.contentHtml).toBe(
                enabled === 'true'
                    ? '<p><img src="/api/images/entries/1/1" alt="Photo"></p>'
                    : html,
            );
            expect(full.fullContent?.html).toBe(
                enabled === 'true'
                    ? '<p><img src="/api/images/entries/1/full/1" alt="Photo"></p>'
                    : html,
            );
        }
        expect((await Effect.runPromise(store.load(1)))?.html).toBe(html);
    });
});

import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleContent } from './ArticleContent';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
});

describe('article image failures', () => {
    // Linkedom propagates ancestor events only when bubbling is enabled.
    it('shows one useful message after an image error without changing the article', async () => {
        const html =
            '<p>Article text.</p><img src="/api/images/entries/1/1" alt="Photo">';
        await act(() =>
            root.render(
                <ArticleContent
                    html={html}
                    originalUrl="https://publisher.example.test/article"
                />,
            ),
        );
        expect(container.querySelector('[role="status"]')).toBeNull();

        await act(() =>
            container
                .querySelector('img')
                ?.dispatchEvent(new window.Event('error', { bubbles: true })),
        );
        const notice = container.querySelector('[role="status"]');
        expect(notice?.textContent).toContain(
            'Some article images could not be loaded.',
        );
        expect(notice?.querySelector('a')?.getAttribute('href')).toBe(
            'https://publisher.example.test/article',
        );
        expect(notice?.querySelector('a')?.getAttribute('rel')).toBe(
            'noopener noreferrer',
        );
        expect(container.textContent).toContain('Article text.');
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
            '/api/images/entries/1/1',
        );
        await act(() =>
            container
                .querySelector('img')
                ?.dispatchEvent(new window.Event('error', { bubbles: true })),
        );
        expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

        await act(() =>
            root.render(
                <ArticleContent
                    html="<p>Another article.</p>"
                    originalUrl={null}
                />,
            ),
        );
        expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it('does not blame image loading for unrelated element errors', async () => {
        await act(() =>
            root.render(
                <ArticleContent html="<video></video>" originalUrl={null} />,
            ),
        );
        await act(() =>
            container
                .querySelector('video')
                ?.dispatchEvent(new window.Event('error', { bubbles: true })),
        );
        expect(container.querySelector('[role="status"]')).toBeNull();
    });
});

import { parseHTML } from 'linkedom';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFullArticleMode } from './fullArticleMode';

afterEach(() => vi.unstubAllGlobals());

function setup(storage: 'fresh' | 'legacy' | 'blocked' = 'fresh') {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    const getItem = vi.fn(() => {
        if (storage === 'blocked') throw new Error('Storage is blocked');
        return storage === 'legacy' ? 'false' : null;
    });
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem },
    });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    return { window, getItem };
}

function ArticleMode({ entryId }: { entryId?: number }) {
    const [full, setFull] = useFullArticleMode(entryId);
    return (
        <button type="button" onClick={() => setFull((value) => !value)}>
            {full ? 'full' : 'feed'}
        </button>
    );
}

describe('full article mode', () => {
    it.each(['fresh', 'legacy', 'blocked'] as const)(
        'defaults to full articles with %s browser storage',
        async (storage) => {
            const { getItem } = setup(storage);
            const container = document.createElement('div');
            const root = createRoot(container);
            try {
                await act(() => root.render(<ArticleMode entryId={501} />));
                expect(container.textContent).toBe('full');
                expect(getItem).not.toHaveBeenCalled();
            } finally {
                await act(() => root.unmount());
            }
        },
    );

    it('keeps feed text temporary and restores full text when changing or reopening articles', async () => {
        const { window } = setup();
        const container = document.createElement('div');
        const root = createRoot(container);
        const render = (entryId: number) =>
            root.render(
                <StrictMode>
                    <ArticleMode entryId={entryId} />
                </StrictMode>,
            );
        try {
            await act(() => render(501));
            await act(() =>
                container
                    .querySelector('button')
                    ?.dispatchEvent(
                        new window.Event('click', { bubbles: true }),
                    ),
            );
            expect(container.textContent).toBe('feed');
            await act(() => render(501));
            expect(container.textContent).toBe('feed');
            await act(() => render(502));
            expect(container.textContent).toBe('full');
            await act(() => render(501));
            expect(container.textContent).toBe('full');
        } finally {
            await act(() => root.unmount());
        }
    });

    it('uses the same default during server rendering', () => {
        expect(renderToStaticMarkup(<ArticleMode entryId={501} />)).toContain(
            'full',
        );
    });
});

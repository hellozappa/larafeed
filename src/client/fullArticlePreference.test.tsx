import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    fullArticlePreferenceKey,
    readFullArticlePreference,
    useFullArticlePreference,
    writeFullArticlePreference,
} from './fullArticlePreference';

afterEach(() => vi.unstubAllGlobals());

function setup() {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        },
    });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    return { window, values };
}

function Preference({ feedId }: { feedId: number }) {
    const [full, setFull] = useFullArticlePreference(feedId);
    return (
        <button type="button" onClick={() => setFull((value) => !value)}>
            {full ? 'full' : 'feed'}
        </button>
    );
}

describe('full article preference', () => {
    it('remembers each feed and changes feeds without copying the previous choice', async () => {
        const { window, values } = setup();
        values.set(fullArticlePreferenceKey(501), 'true');
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(() => root.render(<Preference feedId={501} />));
            expect(container.textContent).toBe('full');
            await act(() => root.render(<Preference feedId={502} />));
            expect(container.textContent).toBe('feed');
            await act(() =>
                container
                    .querySelector('button')
                    ?.dispatchEvent(
                        new window.Event('click', { bubbles: true }),
                    ),
            );
            expect(container.textContent).toBe('full');
            expect(values.get(fullArticlePreferenceKey(502))).toBe('true');
            await act(() => root.render(<Preference feedId={501} />));
            await act(() =>
                container
                    .querySelector('button')
                    ?.dispatchEvent(
                        new window.Event('click', { bubbles: true }),
                    ),
            );
            expect(values.get(fullArticlePreferenceKey(501))).toBe('false');
            await act(() => root.render(<Preference feedId={502} />));
            expect(container.textContent).toBe('full');
        } finally {
            await act(() => root.unmount());
        }
    });

    it('keeps a session choice usable when browser storage is blocked', () => {
        const { window } = setup();
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        writeFullArticlePreference(503, true);
        expect(readFullArticlePreference(503)).toBe(true);
        writeFullArticlePreference(503, false);
        expect(readFullArticlePreference(503)).toBe(false);
        expect(readFullArticlePreference(undefined)).toBe(false);
        expect(readFullArticlePreference(504)).toBe(false);
    });
});

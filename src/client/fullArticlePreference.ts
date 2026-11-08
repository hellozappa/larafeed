import { useCallback, useSyncExternalStore } from 'react';

const changedEvent = 'larafeed-full-article-preference';
const sessionFallback = new Map<number, boolean>();
export const fullArticlePreferenceKey = (feedId: number) =>
    `larafeed-feed-${feedId}-full-article`;

export function readFullArticlePreference(feedId: number | undefined): boolean {
    if (feedId === undefined) return false;
    const fallback = sessionFallback.get(feedId);
    if (fallback !== undefined) return fallback;
    try {
        return (
            window.localStorage.getItem(fullArticlePreferenceKey(feedId)) ===
            'true'
        );
    } catch {
        return false;
    }
}

export function writeFullArticlePreference(
    feedId: number,
    value: boolean,
): void {
    try {
        window.localStorage.setItem(
            fullArticlePreferenceKey(feedId),
            String(value),
        );
        sessionFallback.delete(feedId);
    } catch {
        // Storage may be blocked. Keep the choice usable for this session.
        sessionFallback.set(feedId, value);
    }
    window.dispatchEvent(new Event(changedEvent));
}

const subscribe = (listener: () => void) => {
    window.addEventListener('storage', listener);
    window.addEventListener(changedEvent, listener);
    return () => {
        window.removeEventListener('storage', listener);
        window.removeEventListener(changedEvent, listener);
    };
};

export function useFullArticlePreference(feedId: number | undefined) {
    const getSnapshot = useCallback(
        () => readFullArticlePreference(feedId),
        [feedId],
    );
    const value = useSyncExternalStore(subscribe, getSnapshot, () => false);
    const setValue = useCallback(
        (next: boolean | ((current: boolean) => boolean)) => {
            if (feedId === undefined) return;
            writeFullArticlePreference(
                feedId,
                typeof next === 'function'
                    ? next(readFullArticlePreference(feedId))
                    : next,
            );
        },
        [feedId],
    );
    return [value, setValue] as const;
}

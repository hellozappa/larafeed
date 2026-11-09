import { useCallback, useState } from 'react';

export function useFullArticleMode(entryId: number | undefined) {
    const [mode, setMode] = useState({ entryId, full: true });
    if (mode.entryId !== entryId) {
        setMode({ entryId, full: true });
    }
    const full = mode.entryId === entryId ? mode.full : true;
    const setValue = useCallback(
        (next: boolean | ((current: boolean) => boolean)) => {
            setMode((current) => ({
                entryId,
                full:
                    typeof next === 'function'
                        ? next(
                              current.entryId === entryId ? current.full : true,
                          )
                        : next,
            }));
        },
        [entryId],
    );
    return [full, setValue] as const;
}

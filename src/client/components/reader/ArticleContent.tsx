import { useState } from 'react';

import classes from './Reader.module.css';

export function ArticleContent({
    html,
    originalUrl,
}: {
    readonly html: string;
    readonly originalUrl: string | null;
}) {
    const [failedHtml, setFailedHtml] = useState<string | null>(null);

    return (
        <div
            className={classes.articleContent}
            onErrorCapture={(event) => {
                if (
                    event.target instanceof Element &&
                    event.target.tagName === 'IMG'
                ) {
                    setFailedHtml(html);
                }
            }}
        >
            {failedHtml === html && (
                <p role="status">
                    Some article images could not be loaded.{' '}
                    {originalUrl === null ? (
                        'Try again later.'
                    ) : (
                        <a
                            href={originalUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            Open the original article
                        </a>
                    )}
                </p>
            )}
            {/* Article HTML is sanitized by the Worker before storage. */}
            <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

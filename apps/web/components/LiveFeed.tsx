'use client';

/**
 * Live win feed — ported from `_buildLiveFeedCard` / `_buildWinCard`
 * (main_screen.dart:5778 / 5929).
 *
 * Newest entry on top; the list is capped upstream at 20.
 */

import { tr } from '@euro/shared';
import styles from './LiveFeed.module.css';

export function LiveFeed({ logs }: { logs: string[] }) {
  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          <span className={styles.dot} aria-hidden="true" />
          {tr('أرباح مباشرة', 'Live wins')}
        </h2>
      </header>

      {logs.length === 0 ? (
        <p className={styles.empty}>{tr('في انتظار نتائج جديدة...', 'Waiting for new results…')}</p>
      ) : (
        <ul className={styles.list} aria-live="polite">
          {logs.map((log, i) => (
            // The feed is a stream of generated lines with no stable id; the
            // index is the position in that stream, which is what identifies it.
            <li key={`${log}-${i}`} className={styles.row}>
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>
              <span className={styles.text} dir="ltr">
                {log}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

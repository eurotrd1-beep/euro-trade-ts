'use client';

/**
 * Live win feed — ported from `_buildLiveFeedCard` / `_buildWinCard`
 * (main_screen.dart:5778 / 5929).
 *
 * Newest entry on top; the list is capped upstream at 20.
 *
 * The entries are the same values the Dart engine generates. Only the layout
 * differs: instead of one green-bordered box per line, the feed is a plain
 * list — trader, pair and direction on one side, the profit on the other —
 * which reads as a ledger rather than a console dump.
 */

import { tr } from '@euro/shared';
import type { SocialWin } from '@/lib/useSocialFeed';
import styles from './LiveFeed.module.css';

export function LiveFeed({ logs }: { logs: SocialWin[] }) {
  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <h2 className={styles.title}>{tr('أرباح مباشرة', 'Live wins')}</h2>
        <span className={styles.live}>
          <span className={styles.dot} aria-hidden="true" />
          {tr('مباشر', 'Live')}
        </span>
      </header>

      {logs.length === 0 ? (
        <p className={styles.empty}>{tr('في انتظار نتائج جديدة...', 'Waiting for new results…')}</p>
      ) : (
        <ul className={styles.list} aria-live="polite">
          {logs.map((win, i) => (
            // The feed is a stream of generated lines with no stable id; the
            // index is the position in that stream, which is what identifies it.
            <li key={`${win.text}-${i}`} className={styles.row}>
              <div className={styles.who}>
                <span className={styles.name}>
                  {win.name}
                  <span className={styles.userId} dir="ltr">
                    {win.userId}***
                  </span>
                </span>
                <span className={styles.meta} dir="ltr">
                  {win.asset}
                  <span
                    className={win.direction === 'CALL' ? styles.call : styles.put}
                    title={win.direction}
                  >
                    {win.direction === 'CALL' ? '▲' : '▼'} {win.direction}
                  </span>
                </span>
              </div>

              <span className={styles.profit} dir="ltr">
                +${win.profit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

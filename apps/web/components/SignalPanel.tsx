'use client';

/**
 * Signal panel — ported from `_buildSignalPanel` (main_screen.dart:4645).
 *
 * Which state wins, in order:
 *
 *   isAnalyzing              → the analysis panel (stage text + spinner)
 *   isMonitoring && !signal  → the watching panel
 *   signal == null           → the idle panel: header, description, duration
 *                              selector, then the one button
 *   otherwise                → the active/finished trade
 *
 * The original had two buttons here, instant and monitoring. They are one now,
 * and the four states above are no longer four screens the user navigates
 * between — they are the stages of a single press, in the order it goes
 * through them: analysing, then watching if the first candle said no, then the
 * trade. Nothing here is chosen any more except the duration.
 */

import { formatPrice, tr } from '@euro/shared';
import type { TradingSignal } from '@euro/engine';
import { formatElapsed, type MonitoringState } from '@/lib/useMonitoring';
import styles from './SignalPanel.module.css';

const DURATIONS = [1, 2, 5, 10];

/** Arabic pluralises 1 / 2 / 3+ differently, as the original does. */
function durationLabel(minutes: number): string {
  const ar = minutes === 1 ? 'دقيقة واحدة' : minutes === 2 ? 'دقيقتين' : `${minutes} دقائق`;
  return tr(ar, `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
}

function mmss(total: number): string {
  const s = Math.max(0, total);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface SignalPanelProps {
  signal: TradingSignal | null;
  secondsRemaining: number;
  waitNotice: string;
  analysing: boolean;
  analysisStage: string;
  candleSecondsLeft: number;
  marketClosed: boolean;
  pair: string;
  timeframe: string;
  selectedMinutes: number;
  onSelectMinutes: (m: number) => void;
  onRequest: () => void;
  onClear: () => void;
  hasCandles: boolean;
  /** True when the strategy fixes the trade length and the picker is inert. */
  fixedDuration: boolean;
  /** Shown so the user knows which strategy is about to run. */
  strategyName: string | null;
  /** How many pairs the user has chosen. Zero disables the button. */
  watchedCount: number;
  /**
   * How many of those are open right now.
   *
   * Separate from `watchedCount` because the two disabled states have different
   * answers: "you have not chosen any" is fixed in settings, and "everything
   * you chose is shut for the weekend" is fixed by waiting or by adding an OTC
   * pair. One message for both would send half the users to the wrong place.
   */
  openCount: number;
  /** Opens the settings sheet — pairs, and whether to be alerted about them. */
  onOpenSettings: () => void;
  /**
   * Candles the strategy has read since the press — every pair, every sweep.
   *
   * From the engine rather than from the watch loop, which could only count its
   * own passes: with five pairs chosen it said "1" where five candles had been
   * read, describing the loop instead of the work.
   */
  candlesAnalysed: number;
  /**
   * The pair a trade is running on, when it is not the pair on screen.
   *
   * The card for it is deliberately absent here — it lives with its own chart —
   * so without this the panel would show an idle screen offering to start a new
   * analysis while one is already open elsewhere. `requestSignal` would refuse,
   * silently, and a button that does nothing when pressed is worse than one
   * that says why it cannot.
   */
  awayTradePair: string | null;
  monitoring: MonitoringState;
  onStopMonitoring: () => void;
}

export function SignalPanel(props: SignalPanelProps) {
  const { signal, analysing, monitoring } = props;

  // No analysing view any more. Pressing the button starts the watch, and the
  // watch panel is what it starts — a narrated pass over one pair, followed by
  // a countdown, described work the app had stopped doing: the strategy runs
  // over every chosen pair, on every candle, until something fires.
  if (signal !== null) {
    // The trade AND the watch. The watch used to be replaced by the trade card
    // and stopped when the cycle ended, so a user watching five pairs lost
    // sight of the other four the moment one of them fired — and had to press
    // the button again afterwards to get them back. The trade leads, because it
    // is the thing with money on it; the watch continues underneath, because it
    // never stopped.
    return (
      <>
        <TradeView {...props} />
        {monitoring.active && <MonitoringView {...props} compact />}
      </>
    );
  }
  if (analysing || monitoring.active) return <MonitoringView {...props} />;
  return <IdleView {...props} />;
}

/* ── Monitoring ────────────────────────────────────────────────────────────── */

function MonitoringView({
  monitoring,
  waitNotice,
  onStopMonitoring,
  candlesAnalysed,
  watchedCount,
  compact = false,
}: SignalPanelProps & { compact?: boolean }) {
  return (
    <section
      className={`${styles.panel} ${styles.monitoringPanel} ${compact ? styles.monCompact : ''}`}
    >
      <div className={styles.monHead}>
        <span className={styles.radar} aria-hidden="true">
          ◎
        </span>
        <h2 className={styles.monTitle}>
          {compact
            ? tr('والمراقبة مكمّلة على باقي الأزواج', 'And the watch continues on the other pairs')
            : tr('الاستراتيجية شغالة على كل شمعة...', 'The strategy is running on every candle…')}
        </h2>
      </div>

      {/*
        This panel is not a mode the user switched into — it is the press
        carrying on. So it opens by answering the question the user is
        actually holding: the first candle did not match, and here is what
        about it did not match.
      */}
      {/* Both paragraphs answer "why is nothing happening yet", which is not a
          question anybody has while a trade is counting down in front of them. */}
      {!compact && (
      <p className={styles.notMet}>
        {waitNotice === 'min_score'
          ? tr(
              'الشمعة الأولى ما وصلتش الحد الأدنى للتوافق — التحليل مستمر على كل شمعة جديدة لحد ما تطلع إشارة.',
              'The first candle fell short of the minimum confluence — the analysis carries on each new candle until a signal fires.',
            )
          : tr(
              'شروط الاستراتيجية ما تحققتش على الشمعة الأولى — التحليل مستمر على كل شمعة جديدة لحد ما تطلع إشارة.',
              'The strategy conditions were not met on the first candle — the analysis carries on each new candle until a signal fires.',
            )}
      </p>
      )}

      {!compact && (
      <p className={styles.watching}>
        {tr(
          'المراقبة شغالة على كل الأزواج، مش على الزوج اللي قدامك بس. مش محتاج تضغط تاني ولا تفضل قاعد قدام الشاشة — هيوصلك تنبيه أول ما فرصة تتكوّن، وتنبيه تاني أول ما تقرب، وتنبيه أول ما تتحقق. والشارت هيقلب لوحده على الزوج اللي طلعت منه.',
          'The watch runs on every pair, not just the one on screen. You get an alert when an opportunity forms, another when it gets close, and one the moment it triggers — and the chart switches to the pair on its own.',
        )}
      </p>
      )}

      {/*
        The stat row from `_buildMonitoringCard` (main_screen.dart:4133), plus
        the candles-analysed box: the countdown answers "when", but only the
        count answers "how long has it been looking without finding anything".
      */}
      <div className={styles.monStats}>
        <MonStat
          label={tr('الشمعة القادمة بعد', 'Next candle in')}
          value={mmss(monitoring.countdown)}
          tone="amber"
        />
        <MonStat
          label={tr(
            `شموع اتحللت · ${watchedCount} زوج`,
            `Candles analysed · ${watchedCount} pairs`,
          )}
          value={String(candlesAnalysed)}
          tone="cyan"
        />
        <MonStat
          label={tr('مدة الانتظار', 'Time waiting')}
          value={formatElapsed(monitoring.elapsedSeconds)}
          tone="green"
        />
      </div>

      {/*
        The watch ends by itself on the first signal, so this is a cancel, not
        the other half of a toggle — it is here for the user who changed their
        mind about the pair or the duration.
      */}
      <button type="button" onClick={onStopMonitoring} className={styles.stopBtn}>
        {tr('إلغاء', 'Cancel')}
      </button>
    </section>
  );
}

/** One box in the monitoring stat row. */
function MonStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'amber' | 'cyan' | 'green';
}) {
  return (
    <div className={`${styles.monStat} ${styles[`mon_${tone}`]}`}>
      <span className={styles.monStatLabel}>{label}</span>
      <span className={styles.monStatValue} dir="ltr">
        {value}
      </span>
    </div>
  );
}

/* ── Idle ──────────────────────────────────────────────────────────────────── */

function IdleView({
  waitNotice,
  marketClosed,
  pair,
  timeframe,
  selectedMinutes,
  onSelectMinutes,
  onRequest,
  hasCandles,
  fixedDuration,
  strategyName,
  watchedCount,
  openCount,
  onOpenSettings,
  awayTradePair,
}: SignalPanelProps) {
  const name = pair.replace(' (OTC)', '');
  /**
   * Nothing chosen is a different kind of disabled from the other two.
   *
   * A closed market or an empty candle buffer are conditions the user cannot
   * act on and only has to wait out. This one is a step they have not taken
   * yet, and it is the FIRST thing that has to happen on a new install — so it
   * is named separately and answered with the way out of it, rather than with a
   * grey button and no explanation.
   */
  const nothingChosen = watchedCount === 0;
  const allShut = !nothingChosen && openCount === 0;
  const disabled =
    nothingChosen || allShut || !hasCandles || marketClosed || awayTradePair !== null;

  return (
    <section className={styles.panel}>
      <header className={styles.idleHead}>
        <span className={styles.brainIcon} aria-hidden="true">
          🧠
        </span>
        <div>
          <p className={styles.sensorTag}>VIP ALGORITHM SENSOR</p>
          <p className={styles.sensorTitle}>
            {tr('التحليل جاهز للاستخراج', 'Analysis ready to extract')}
          </p>
        </div>
      </header>

      <hr className={styles.divider} />

      <p className={styles.description}>
        {tr(
          `اضغط أدناه عشان الاستراتيجية تشتغل على ${name} وعلى باقي الأزواج كلها بفريم ${timeframe}، وتفضل شغالة على كل شمعة لحد ما تطلع صفقة — وأول ما تطلع، الشارت هيقلب لزوجها لوحده.`,
          `Tap below to run the strategy on ${name} and every other pair at ${timeframe}, candle by candle, until a trade appears — and the chart will switch to its pair on its own.`,
        )}
      </p>

      {marketClosed && (
        <div className={styles.waitBanner} role="status">
          {tr('السوق مغلق حالياً', 'The market is currently closed')}
        </div>
      )}

      {/*
        Only reachable after the user cancelled a watch: a press that ends in
        "not this candle" goes straight on watching instead of coming back
        here. Kept so the panel still explains itself in that one case.
      */}
      {waitNotice && (
        <div className={styles.waitBanner} role="status">
          {waitNotice === 'strategy'
            ? tr(
                'آخر محاولة وقفت قبل ما تطلع إشارة — شروط الاستراتيجية ما تحققتش',
                'The last attempt stopped before a signal — the strategy conditions were not met',
              )
            : tr(
                'آخر محاولة وقفت قبل ما تطلع إشارة — الحد الأدنى للتوافق (min_score) ما تحققش',
                'The last attempt stopped before a signal — the minimum confluence (min_score) was not reached',
              )}
        </div>
      )}

      {fixedDuration ? (
        <div className={styles.durations}>
          <div className={styles.durationHead}>
            <span className={styles.label}>{tr('مدة الصفقة:', 'Trade duration:')}</span>
            <span className={styles.durationValue}>{durationLabel(selectedMinutes)}</span>
          </div>
          <p className={styles.durationNote}>
            {tr(
              `الاستراتيجية «${strategyName ?? ''}» بتحدد المدة والفريم بنفسها — الصفقة شمعة واحدة على فريم ${timeframe}.`,
              `The "${strategyName ?? ''}" strategy sets its own duration and timeframe — one candle on ${timeframe}.`,
            )}
          </p>
        </div>
      ) : (
        <DurationSelector selected={selectedMinutes} onSelect={onSelectMinutes} />
      )}

      {awayTradePair !== null && (
        <p className={styles.needPairs} role="status">
          {tr(
            `فيه صفقة شغالة دلوقتي على ${awayTradePair} — استنى تخلص.`,
            `A trade is running on ${awayTradePair} right now — wait for it to finish.`,
          )}
        </p>
      )}

      {nothingChosen && (
        <p className={styles.needPairs} role="status">
          {tr(
            '⚙️ اختار الأزواج اللي عايز تتابعها الأول من الترس جنب الزرار.',
            '⚙️ Choose the pairs you want to follow first, from the gear beside the button.',
          )}
        </p>
      )}

      {allShut && (
        <p className={styles.needPairs} role="status">
          {tr(
            `كل الـ${watchedCount} زوج اللي مختارهم أسواقهم مقفولة دلوقتي. ضيف زوج OTC من ⚙️ — دي بتشتغل 24/7.`,
            `All ${watchedCount} pairs you chose are closed right now. Add an OTC pair from ⚙️ — those trade 24/7.`,
          )}
        </p>
      )}

      <div className={styles.buttonRow}>
        {/*
          Beside the button it gates, because that is the only place it reads as
          a precondition for pressing. Under the account card it looked like one
          more account setting, which is exactly how the step that has to happen
          first gets missed.
        */}
        <button
          type="button"
          onClick={onOpenSettings}
          className={`${styles.gearBtn} ${nothingChosen ? styles.gearWaiting : ''}`}
          aria-label={tr('إعدادات الأزواج والإشعارات', 'Pairs and alerts settings')}
          title={
            watchedCount === 0
              ? tr('اختار الأزواج', 'Choose pairs')
              : tr(`${watchedCount} زوج مختار`, `${watchedCount} pairs selected`)
          }
        >
          <span aria-hidden="true">⚙️</span>
          {watchedCount > 0 && <span className={styles.gearCount}>{watchedCount}</span>}
        </button>

        <button type="button" onClick={onRequest} disabled={disabled} className={styles.requestBtn}>
          {awayTradePair !== null
            ? tr('فيه صفقة شغالة', 'A trade is running')
            : nothingChosen
              ? tr('محتاج تختار أزواج الأول', 'Choose your pairs first')
              : allShut
                ? tr('أسواق أزواجك مقفولة', 'Your markets are closed')
                : tr('حلّل وولّد إشارة ⚡', 'Analyse and generate a signal ⚡')}
        </button>
        <HelpButton
          text={tr(
            `بيشغّل استراتيجية خطتك على كل الأزواج اللي اخترتها (${watchedCount}) في نفس الوقت، وبيستنى إغلاق الشمعة عشان الصفقة تفتح مع اللي بعدها. لو الشروط ما تحققتش على ولا زوج، بيفضل يعيد على كل شمعة جديدة لحد ما تطلع إشارة — من غير ما تضغط تاني.`,
            `Runs your plan's strategy across all ${watchedCount} pairs you chose at once, and waits for the candle to close so the trade opens with the next one. If the conditions hold on none of them, it keeps re-running on every new candle until a signal fires — without you pressing again.`,
          )}
        />
      </div>
    </section>
  );
}

function DurationSelector({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect: (m: number) => void;
}) {
  return (
    <div className={styles.durations}>
      <div className={styles.durationHead}>
        <span className={styles.label}>{tr('مدة الصفقة المستهدفة:', 'Target trade duration:')}</span>
        <span className={styles.durationValue}>{durationLabel(selected)}</span>
      </div>
      <div className={styles.durationRow} role="group">
        {DURATIONS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSelect(m)}
            className={`${styles.durationBtn} ${selected === m ? styles.durationActive : ''}`}
            aria-pressed={selected === m}
          >
            {tr(`${m} د`, `${m}m`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function HelpButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className={styles.helpBtn}
      title={text}
      onClick={() => alert(text)}
    >
      <span aria-hidden="true">؟</span>
      <span className="sr-only">{text}</span>
    </button>
  );
}

/* ── Active / finished trade ───────────────────────────────────────────────── */

function TradeView({ signal, secondsRemaining, onClear }: SignalPanelProps) {
  if (!signal) return null;
  const active = signal.status === 'ACTIVE';
  const isCall = signal.direction === 'CALL';
  const isMartingale = signal.stage === 'martingale';

  if (active) {
    return (
      <section className={styles.panel}>
        {/* Stated before the card, not inside it: this trade exists because the
            last one lost, and that is the thing to read first. */}
        {isMartingale && (
          <div className={styles.martingale} role="status">
            {tr(
              '🔁 مضاعفة — الصفقة دي تعويض عن اللي قبلها، وبمضاعفة واحدة بس. مفيش تالتة مهما حصل.',
              '🔁 Martingale — this trade recovers the last one, doubled once. There is no second double.',
            )}
          </div>
        )}
        <div className={`${styles.signalCard} ${isCall ? styles.call : styles.put}`}>
          {/* The pair, first and unmissable. The watch scans every market, so
              the trade on screen is frequently NOT the chart the user was
              looking at a second ago — and a direction without a market is
              worse than no card at all. */}
          <p className={styles.signalPair}>{signal.pair}</p>
          <div className={styles.directionRow}>
            <span className={styles.direction}>
              {isCall ? '▲' : '▼'} {signal.direction}
            </span>
            <span className={styles.countdown} dir="ltr">
              {mmss(secondsRemaining)}
            </span>
          </div>

          <dl className={styles.metrics}>
            <Metric label={tr('سعر الدخول', 'Entry price')} value={formatPrice(signal.entryPrice)} />
            <Metric label={tr('الثقة', 'Confidence')} value={`${signal.confidence.toFixed(1)}%`} />
            <Metric label={tr('المدة', 'Duration')} value={durationLabel(signal.durationMinutes)} />
          </dl>
        </div>
      </section>
    );
  }

  const result = signal.status;
  const cls =
    result === 'WIN' ? styles.win : result === 'LOSS' ? styles.loss : styles.tie;
  const resultLabel =
    result === 'WIN'
      ? isMartingale
        ? tr('المضاعفة عوّضت الخسارة ✅', 'The double recovered the loss ✅')
        : tr('صفقة رابحة ✅', 'Winning trade ✅')
      : result === 'LOSS'
        ? isMartingale
          ? tr('خسارة نهائية — الدورة انتهت ❌', 'Final loss — the cycle is over ❌')
          : tr('صفقة خاسرة ❌', 'Losing trade ❌')
        : result === 'UNRESOLVED'
          // Said plainly rather than dressed as a tie: the trade ran, and the
          // candle it ran on never arrived, so there is no price to judge it
          // by. A card that claimed a draw here would be inventing one.
          ? tr('الشمعة مجاش سعرها — النتيجة مش محسومة', 'No price for the candle — result undecided')
          : tr('تعادل — تم رد الرهان', 'Tie — stake refunded');

  return (
    <section className={styles.panel}>
      <div className={`${styles.signalCard} ${cls}`}>
        <p className={styles.signalPair}>{signal.pair}</p>
        <p className={styles.resultText}>{resultLabel}</p>

        <dl className={styles.metrics}>
          <Metric label={tr('الدخول', 'Entry')} value={formatPrice(signal.entryPrice)} />
          <Metric
            label={tr('الإغلاق', 'Close')}
            value={signal.exitPrice !== null ? formatPrice(signal.exitPrice) : '—'}
          />
          <Metric label={tr('الاتجاه', 'Direction')} value={signal.direction} />
        </dl>

        {/*
          A primary trade lost, so the strategy owes one recovery attempt at
          double the stake — and the user is the one who has to place it, so the
          instruction has to be here, on the card that just told them they lost.
          Only after a PRIMARY loss: a losing martingale ends the cycle, and
          telling somebody to double again there would be inventing a third
          trade the strategy will never take.
        */}
        {result === 'LOSS' && !isMartingale && (
          <p className={styles.doubleUp} role="status">
            {tr(
              '🔁 ضاعِف مبلغ الصفقة دي في الصفقة الجاية على نفس الزوج — فرصة تعويض واحدة بس، مفيش تالتة.',
              '🔁 Double this trade’s stake on the next one, same pair — one recovery attempt only, never a third.',
            )}
          </p>
        )}

        <button type="button" onClick={onClear} className={styles.clearBtn}>
          {tr('إشارة جديدة', 'New signal')}
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd dir="ltr">{value}</dd>
    </div>
  );
}

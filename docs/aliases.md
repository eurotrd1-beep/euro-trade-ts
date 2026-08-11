# الأسماء المكرّرة في المحرك

> مولَّد من `scripts/audit-aliases.mts` — لا يُحرَّر يدويًا.

**237** اسم مسجّل = **191** حسبة مختلفة. 
**46** اسم منهم لافتة على تنفيذ اسم تاني.

الأسماء دي **مُتبقّاة عن قصد**: محرك الدارت فيه نفس المرادفات وبيرجّع نفس القيم،
والتطابق معه هو عقد الهجرة. الحل مش حذف الاسم — الحل إن حد يقولك.

## ليه ده مهم

الاستراتيجية بتتحسب بعدّ القواعد. تلات قواعد على `doji` و `harami` و `marubozu`
شكلها تلات تأكيدات مستقلة وبتضيف تلات نتايج — وهي **قراءة واحدة اتحسبت تلاتة**.
ولا حاجة في المحرك بتلاحظ.

## الحماية

| أين | ماذا |
| --- | --- |
| `aliasConflicts()` في المحرك | يرجّع كل مجموعة استُخدم منها اسمان أو أكثر |
| زرار اختبار الاستراتيجية في الأدمن | خطأ أحمر يمنع الرفع |
| `scripts/check-live-strategies.mts` | يفشّل النشر |
| المرجع + بروميت جيميناي | كل اسم مكتوب جنبه مرادفه |

مضاعف الإجماع **مش متأثر**: كل أعضاء أي مجموعة بيقعوا في نفس التصنيف، فالمرادفات
مش بتضخّمه من نفسها. الطريق الوحيد لتضخيمه هو `type` صريح مختلف على اسمين من نفس
المجموعة — والحارس بيمنع الحالة دي من أساسها.

## المجموعات المضلّلة — الاسم بيقول حاجة والدالة بتعمل حاجة تانية

### `advanced_candle`

**الاسم الحقيقي:** candle_pattern_any — returns ANY candlestick pattern the detector found. The specific name you asked for is not what it tests

يشمل: `advanced_candle`، `doji`، `dragonfly_doji`، `gravestone_doji`، `spinning_top`، `marubozu`، `tweezer`، `harami`، `kicker`، `abandoned_baby`، `belt_hold`، `three_inside`، `three_outside`

### `5_0`

**الاسم الحقيقي:** harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it

يشمل: `5_0`، `ab_cd`

### `bat`

**الاسم الحقيقي:** harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it

يشمل: `bat`، `alternate_bat`

### `crab`

**الاسم الحقيقي:** harmonic_pattern_any — one detector behind two different harmonic patterns. Asking for a specific one does not select it

يشمل: `crab`، `deep_crab`

## كل المجموعات

| استخدم | نفس الحسبة بالظبط | التصنيف |
| --- | --- | --- |
| `advanced_candle` | `doji`، `dragonfly_doji`، `gravestone_doji`، `spinning_top`، `marubozu`، `tweezer`، `harami`، `kicker`، `abandoned_baby`، `belt_hold`، `three_inside`، `three_outside` | Other |
| `po3` | `power_of_three`، `amd_cycle` | Other |
| `5_0` | `ab_cd` | Rare Patterns |
| `ac` | `accelerator_oscillator` | Other |
| `ao` | `awesome_oscillator` | Other |
| `aroon` | `aroon_oscillator` | Trend |
| `bat` | `alternate_bat` | Rare Patterns |
| `broadening_wedge` | `megaphone` | Other |
| `camarilla` | `camarilla_pivot` | Other |
| `ce` | `consequent_encroachment` | Other |
| `chande_kroll_stop` | `ckstop` | Other |
| `crab` | `deep_crab` | Rare Patterns |
| `demark` | `td_sequential` | Other |
| `demark_p` | `demark_pivot` | Other |
| `diamond` | `diamond_top` | Other |
| `dow_theory` | `trend_following` | Trend |
| `elder_bear_power` | `bear_power` | Other |
| `elder_bull_power` | `bull_power` | Other |
| `eqh` | `equal_highs` | Rare Patterns |
| `eql` | `equal_lows` | Rare Patterns |
| `fakey` | `inside_bar_fakey` | Other |
| `fib_pivot` | `fibonacci_pivot` | Other |
| `fib_time` | `fibonacci_time_zone` | Other |
| `historical_volatility` | `hv` | Other |
| `hma` | `hull_ma` | Trend |
| `ib` | `initial_balance` | Other |
| `lsma` | `linear_regression` | Trend |
| `market_profile` | `tpo` | Other |
| `market_regime_classification` | `regime_detection` | Advanced Statistics |
| `momentum` | `momentum_trading` | Other |
| `orb` | `opening_range_breakout` | Price Levels |
| `rectangle` | `horizontal_channel` | Other |
| `starc` | `starc_bands` | Other |
| `woodie` | `woodie_pivot` | Other |

## متطابقة على العيّنة — بدوال مختلفة

دوال منفصلة رجّعت نفس القيمة في كل نقطة من عيّنة 15,884 نقطة. **مش إثبات**
تطابق — ممكن يختلفوا على داتا العيّنة ماشافتهاش — لكن عاملهم كدليل واحد مش اتنين.

| | |
| --- | --- |
| `fair_value_gap` | `imbalance` |
| `opening_range` | `opening_range_breakout`، `orb` |
| `pennant` | `symmetrical_triangle` |
| `wyckoff` | `wyckoff_spring` |

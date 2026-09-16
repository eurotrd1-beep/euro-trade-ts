# Moving off Supabase — the steps that have to be run by a person

Everything in this repo is code and tests. This file is the part that touches
live systems, and it is written down rather than automated on purpose: each
step below has a check after it, and the check is the reason the step is safe.

**The one rule.** Supabase keeps its data until the end, and after the freeze
it keeps it read-only. Nothing here deletes a row from it, at any point.

---

## Before anything: the backup

No `pg_dump` is needed on the machine — Docker has one:

```bash
cd apps/data-hub                        # SUPABASE_DB_URL in .env.local
PW=$(node -e "import('./scripts/env.mjs').then(()=>console.log(new URL(process.env.SUPABASE_DB_URL).password))")
URL="postgresql://postgres.<ref>:$PW@aws-1-eu-central-1.pooler.supabase.com:6543/postgres"
IMG=public.ecr.aws/supabase/postgres:17.6.1.167

docker run --rm $IMG pg_dump "$URL" --schema=public --no-owner --no-privileges   --schema-only > backup/schema.sql
docker run --rm $IMG pg_dump "$URL" --schema=public --no-owner --no-privileges   --data-only   > backup/data.sql
cat backup/schema.sql backup/data.sql > backup/backup.sql

node scripts/verify-backup.mjs backup/backup.sql
```

**Port 6543, not the 5432 the dashboard shows.** Measured: :5432 on this
project accepts the connection and then closes it — "server closed the
connection unexpectedly", which reads like a network fault and is not one.
:6543 works. The direct host `db.<ref>.supabase.co` does not resolve at all;
it is IPv6-only on the free plan.

And percent-encode the password. A `#` starts a URL fragment, so the password
truncates at it silently and the failure looks like a wrong password rather
than a malformed URL.

`pg_dump` exits 0 for a dump that is missing tables, that came back empty
because the role could not read one, and that was cut off mid-way. All three
look like a good dump: the file is there, it is large, it has a header.

`verify-backup.mjs` reads it and prints a row count per table. **Compare those
counts against Supabase before going further.** It refuses outright if the
completion marker is missing or a table has no data section.

Keep `backup.sql` somewhere off this machine. It is the only copy of the
pre-migration state that is not in the system being migrated.

---

## Stage 2 — create the database and load it

```bash
cd apps/data-hub
wrangler d1 create euro-trade                     # put the id in wrangler.jsonc
wrangler d1 execute euro-trade --remote --file migrations/0001_schema.sql
```

Then the load, one table at a time:

```bash
export SUPABASE_SERVICE_KEY='...'                 # needed for the four locked tables

node scripts/introspect.mjs --diff                # MUST report zero differences
node scripts/backfill.mjs plan                    # row counts, and the daily budget
node scripts/backfill.mjs build                   # writes out/<table>.sql
```

`build` loads each file it writes back into an in-memory SQLite and compares
every row against what it read from Supabase. A value that does not survive
the round trip fails there, before D1 has seen anything.

Read a file, then apply it:

```bash
wrangler d1 execute euro-trade --remote --file out/candles.sql
```

**D1's free plan allows 100,000 row writes per day.** `plan` prints the total.
Over that, the load stops part-way and every query on the database is blocked
until 00:00 UTC — so split it across days rather than finding out.

### Check

```bash
wrangler d1 execute euro-trade --remote \
  --command "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'signals', COUNT(*) FROM signals"
```

Row counts equal on both sides, table by table. Not "about right".

---

## Stage 3 — the app reads D1, still writes Supabase

```bash
wrangler secret put SERVICE_SECRET                # openssl rand -base64 32
wrangler secret put ADMIN_SECRET                  # openssl rand -base64 32
wrangler deploy
```

Then, in Supabase, one row:

```sql
INSERT INTO configs (id, data) VALUES
  ('data_source', '{"mode":"mirror","url":"https://euro-trade-data.<sub>.workers.dev"}')
ON CONFLICT (id) DO UPDATE SET data = excluded.data;
```

`mirror` reads D1 and **falls back to Supabase when a read fails**. Both hold
the same rows at this point, so a fallback is invisible and correct — the hub
can be wrong all afternoon and nobody's app breaks.

### Check

Leave it here for a day. The health screen shows `hubStats`: reads, fallbacks,
errors. **Fallbacks must reach zero and stay there.** A non-zero count is the
hub failing and the app hiding it for you, which is what this mode is for —
but going to stage 4 with fallbacks still happening removes the net.

### Rollback

`mode` → `"supabase"`. That is the whole rollback, and it works even if D1 is
down, because the flag is read from Supabase on purpose.

---

## Stage 4 — the app writes D1

Take **a second `pg_dump`** first. The one from this morning is now missing a
day of trades.

```sql
UPDATE configs SET data = '{"mode":"d1","url":"https://..."}' WHERE id = 'data_source';
```

From here the two databases diverge, and the read fallback is **off** — in
`d1` mode a failed read is an error rather than a stale answer from a Supabase
that is getting further behind by the hour. That is deliberate: a fallback
here would show a trade history that had silently stopped growing.

Point the scraper and the proxy at the hub too: `SERVICE_SECRET` in Render's
environment, and the hub URL in place of the Supabase one.

### Check

A real trade, end to end. Place it, let it settle, reload the app, confirm it
is in the history. Then confirm the same row is in D1 and **not** in Supabase —
that is what proves the write went where you think.

---

## Stage 5 — freeze Supabase, and close the admin

Only after stage 4 has been stable for a few days.

```bash
psql "$PGURL" -f supabase/migrations/20260916_freeze_writes.sql
```

Reads stay open, writes stop, **no row is deleted**. If Supabase kept accepting
writes after the move, both databases would be changing, and a week later
nobody could say which was right — neither could.

`signal_history` and `users` close completely here. Today they carry
`allow all`: anyone with the public key can read and overwrite any account's
trade history, grant themselves VIP, or ban anyone. That ends at this step.

Which means the admin panel must already be on the hub before you run it. Its
gate today is `sha256('joex')` compiled into the bundle — the username is the
password — and it does not matter how strong it is while the anon key is public
and RLS is open. Replace it with `ADMIN_SECRET`, typed at sign-in and held only
in that browser.

### Keeping Supabase

Leave the project up, read-only, for at least a month. It costs nothing on the
free plan and it is the only thing that makes "go back" a sentence rather than
a project.

---

## What each stage costs to undo

| Stage | Rollback | Time |
|---|---|---|
| 2 | Nothing to undo — nothing reads D1 yet | — |
| 3 | `mode` → `supabase` | one row |
| 4 | `mode` → `supabase`; D1 writes since the switch are not in Supabase | one row, plus reconciling that gap |
| 5 | The rollback block at the bottom of the freeze migration, then as above | minutes |

The gap in stage 4 is the reason stage 3 gets a full day first, and the reason
stage 5 waits days rather than hours.

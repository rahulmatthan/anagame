# Word Ladder Forge (Daily Curated)

This app now has:
- Player site at `/` (daily puzzle)
- Admin curation site at `/admin` (manual chain builder and scheduling)

## Run

```bash
cd /Users/rahul/Documents/Anagame
DATABASE_URL=postgresql://USER:PASSWORD@HOST:6543/postgres?sslmode=require \
ADMIN_TOKEN=your_secret_token npm start
```

Then open:
- Player: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`

## Admin Workflow

1. Open `/admin`
2. Enter `ADMIN_TOKEN`
3. Use manual builder
4. Publish chains (dates auto-increment)

Curated puzzles and fastest-time records are stored in Postgres.

On first Postgres startup, existing JSON schedule data in:
- `/Users/rahul/Documents/Anagame/data/puzzles.json`
is auto-migrated into Postgres (if the table is empty).

## Deployment Persistence (Important)

Set these environment variables in Render:
1. `DATABASE_URL` = Supabase connection string (pooled transaction URL recommended)
2. `ADMIN_TOKEN` = strong secret token

No persistent disk is required when using Supabase.

## Notes

- If no curated puzzle exists for today, players will see a \"No curated puzzle scheduled for today.\" message.
- Validation is server-side (`/api/validate`) using `dictionary.txt` + seeded custom words.

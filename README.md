# Word Ladder Forge (Daily Curated)

This app now has:
- Player site at `/` (daily puzzle)
- Admin curation site at `/admin` (generate suggestions and publish by date)

## Run

```bash
cd /Users/rahul/Documents/Anagame
ADMIN_TOKEN=your_secret_token npm start
```

Then open:
- Player: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`

## Admin Workflow

1. Open `/admin`
2. Enter `ADMIN_TOKEN`
3. Use manual builder or suggestions
4. Publish chains (dates auto-increment)

Curated puzzles are stored in SQLite:
- `/Users/rahul/Documents/Anagame/data/puzzles.db`

On first run, existing JSON data in:
- `/Users/rahul/Documents/Anagame/data/puzzles.json`
is auto-migrated into SQLite.

## Deployment Persistence (Important)

To avoid losing schedules on redeploy, your host must keep the `data/` folder on persistent storage.

### Render setup
1. Add a Persistent Disk to the service.
2. Mount path: `/opt/render/project/src/data`
3. Redeploy.

This path matches the app's `data/puzzles.db` location.

## Notes

- If no curated puzzle exists for today, the server returns an auto-generated fallback.
- Validation is server-side (`/api/validate`) using `dictionary.txt` + seeded custom words.

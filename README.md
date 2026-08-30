# Classync

A shared calendar for Spaces (classes, teams, groups) sitting beside a private
To Do list — Space tasks and Space events on one grid, told apart by
color/shape, next to your own dated to-dos and notes that no Organizer can ever see.

Documentation:
- [`docs/CLASYNC_MASTER_PLAN.md`](docs/CLASYNC_MASTER_PLAN.md) — architecture, schema, security checklist, build plan; the source of truth for everything
- [`docs/SRS.md`](docs/SRS.md) — the standalone Software Requirements Specification
- [`docs/CHECKLIST_10_DAY.md`](docs/CHECKLIST_10_DAY.md) — the executable, checkbox day-by-day build checklist

## Running locally

```
npm install
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET, etc.
npm run db:migrate     # applies server/database/schema.sql
npm run dev
```

Then open `http://localhost:3000`.

## Testing

```
npm test          # unit/integration (Jest)
npm run test:e2e  # end-to-end (Playwright)
```

## Structure

- `server/` — Node.js/Express backend
- `client/` — plain HTML/CSS/JS frontend, no build step (see docs §6 for why)
- `tests/` — unit, integration, and e2e tests
- `docs/CLASYNC_MASTER_PLAN.md` — the source of truth for everything else

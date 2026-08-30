# Classync

A shared calendar for Spaces (classes, teams, groups) sitting beside a private
To Do list — Space tasks and Space events on one grid, told apart by
color/shape, next

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

# Digital-Data

Elegant Empire AI's digital operations monorepo. The first implementation is a **school web prototype**, not a production school system.

## Run

Node.js 20 or later.

```sh
npm run dev
```

Open http://localhost:3000. Run `npm test` for domain-rule tests.

## Neon database

Set `DATABASE_URL` as a private server environment variable. On startup, the server creates the initial school, user, class, student, attendance, fee, payment and assessment tables when they do not already exist. It never sends the database URL to the browser.

`GET /api/health` returns `200` when the database is connected and `503` when it is missing or unavailable. Do not paste the database URL into client-side JavaScript or commit it to Git.

## Scope

Dashboard, fictional student registration, daily attendance, fee charges and payment receipts, draft results and approval snapshots, CSV reports, and configurable school settings. Layout adapts to phones and desktops. Business, government and NGO applications are not implemented. Android is a later client of the planned backend, not included here.

**Demo only:** browser localStorage contains fictional records. There is no authentication, server database, real school isolation, backup, offline synchronisation, or online payment processing. Do not enter real student or financial data. Browser storage is neither secure nor a durable ledger. A demo-role selector illustrates navigation; it is not access control. Reset restores fictional data.

See `docs/prototype-scope.md` for decisions and implementation gaps. Nothing is published to GitHub or deployed automatically.

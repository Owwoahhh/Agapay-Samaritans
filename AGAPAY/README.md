# Agapay Samaritans

This prototype stores its application state in PostgreSQL through a small Node.js API. The API
listens on `127.0.0.1` only; it is intended for local development, not as a secure production
deployment. Authentication and role checks are still performed in the browser.

## Set up PostgreSQL

1. Create a database named `agapay_samaritans` in PostgreSQL.
2. Connect to that database in pgAdmin (or another PostgreSQL query tool) and run the contents of
   [`database.sql`](./database.sql).
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to your PostgreSQL username, password,
   host, port, and database. Keep `.env` private; it is ignored by Git.

For example, the connection string for a local PostgreSQL server is:

```text
postgresql://postgres:your-password@localhost:5432/agapay_samaritans
```

If the password contains reserved URL characters, percent-encode them in the connection string.

## Run the application

From this folder, install the packages and start the API:

```powershell
npm install
npm start
```

Open <http://127.0.0.1:3000>. Do not open `index.html` directly from File Explorer. The app checks
the database connection at startup, and <http://127.0.0.1:3000/api/health> reports whether
PostgreSQL is connected.

The initial demo login is `admin` / `admin123`. Change it before using the prototype. The database
stores the app's complete state as one JSON document; it does not provide production-grade
authentication, authorization, backups, or multi-user conflict handling. Do not expose this server
to the internet or store real donor or financial information in it.

The `Agapay_Navotas_Synthetic_App_State.json` sample is imported separately into the
`agapay_imported_datasets` table so its original format is preserved without replacing the app's
current state. It is not shown in the existing app screens.

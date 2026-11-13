"use strict";

require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT || 3000);
const appDirectory = __dirname;

app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

app.get("/", (_request, response) => response.sendFile(path.join(appDirectory, "index.html")));
app.get("/script.js", (_request, response) =>
  response.sendFile(path.join(appDirectory, "script.js"))
);
app.get("/style.css", (_request, response) =>
  response.sendFile(path.join(appDirectory, "style.css"))
);

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ database: "connected" });
  } catch (error) {
    console.error("PostgreSQL health check failed:", error.message);
    response.status(503).json({ error: "Cannot connect to PostgreSQL. Check the server setup." });
  }
});

app.get("/api/state", async (_request, response) => {
  try {
    const result = await pool.query("SELECT state FROM agapay_app_state WHERE id = 1");
    response.json({ state: result.rows[0]?.state ?? null });
  } catch (error) {
    console.error("PostgreSQL state load failed:", error.message);
    response.status(500).json({
      error: "Could not load PostgreSQL data. Check DATABASE_URL and run database.sql.",
    });
  }
});

app.put("/api/state", async (request, response) => {
  const { state } = request.body || {};
  if (
    !state ||
    state.version !== 2 ||
    !state.settings ||
    !Array.isArray(state.donors) ||
    !Array.isArray(state.donations) ||
    !Array.isArray(state.receipts) ||
    !Array.isArray(state.users) ||
    !Array.isArray(state.audit)
  ) {
    return response.status(400).json({ error: "Invalid application state." });
  }

  try {
    await pool.query(
      `INSERT INTO agapay_app_state (id, state, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE
       SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(state)]
    );
    response.json({ saved: true });
  } catch (error) {
    console.error("PostgreSQL state save failed:", error.message);
    response.status(500).json({
      error: "Could not save PostgreSQL data. Check the database connection and schema.",
    });
  }
});

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing. Create a .env file from .env.example.");
  }
  await pool.query("SELECT id FROM agapay_app_state WHERE id = 1");
  app.listen(port, "127.0.0.1", () => {
    console.log(`Agapay is running at http://127.0.0.1:${port}`);
  });
}

start().catch(async (error) => {
  console.error("Agapay could not start:", error.message);
  await pool.end();
  process.exitCode = 1;
});

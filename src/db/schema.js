// src/db/schema.js — PostgreSQL schema + pool

import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      firebase_uid  TEXT UNIQUE NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT,
      photo         TEXT,
      plan          TEXT DEFAULT 'free',
      credits       INT DEFAULT 3,
      credits_used  INT DEFAULT 0,
      tokens_used   INT DEFAULT 0,
      country       TEXT,
      city          TEXT,
      region        TEXT,
      stripe_customer_id TEXT,
      stripe_sub_id      TEXT,
      surveys_created    INT DEFAULT 0,
      last_active        TIMESTAMPTZ DEFAULT NOW(),
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS surveys (
      id           SERIAL PRIMARY KEY,
      user_id      INT REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      structure    JSONB,
      qsf          JSONB,
      logic_map    JSONB,
      file_text    TEXT,
      qualtrics_id TEXT,
      status       TEXT DEFAULT 'draft',
      tokens_used  INT DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id         SERIAL PRIMARY KEY,
      user_id    INT REFERENCES users(id) ON DELETE CASCADE,
      action     TEXT,
      tokens     INT DEFAULT 0,
      meta       JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_surveys_user   ON surveys(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_user     ON usage_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);
    CREATE INDEX IF NOT EXISTS idx_usage_created  ON usage_log(created_at);

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS credits      INT DEFAULT 3;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_used INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_used  INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS country      TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS city         TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS region       TEXT;
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS file_text  TEXT;
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;
      ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS meta     JSONB;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `)
  console.log('✅ DB schema ready')
}

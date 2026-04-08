// src/routes/admin.js
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { attachDBUser } from '../middleware/user.js'
import { requirePlan } from '../middleware/auth.js'
import { pool } from '../db/schema.js'

const router = Router()
router.use(requireAuth, attachDBUser, requirePlan('admin'))

// ── Dashboard stats ──────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, surveys, usage, tokens, geo, daily] = await Promise.all([
      pool.query("SELECT plan, COUNT(*)::int as count FROM users GROUP BY plan"),
      pool.query("SELECT status, COUNT(*)::int as count FROM surveys GROUP BY status"),
      pool.query("SELECT action, COUNT(*)::int as count, SUM(tokens)::int as total_tokens FROM usage_log WHERE created_at > now()-interval '30 days' GROUP BY action"),
      pool.query("SELECT SUM(tokens_used)::int as total FROM users"),
      pool.query("SELECT country, COUNT(*)::int as count FROM users WHERE country IS NOT NULL GROUP BY country ORDER BY count DESC LIMIT 30"),
      pool.query(`
        SELECT date_trunc('day', created_at)::date as day, COUNT(*)::int as count
        FROM usage_log WHERE created_at > now()-interval '30 days' AND action='generate'
        GROUP BY day ORDER BY day
      `)
    ])
    res.json({
      users:     users.rows,
      surveys:   surveys.rows,
      usage:     usage.rows,
      totalTokens: tokens.rows[0]?.total || 0,
      geography: geo.rows,
      dailyGenerations: daily.rows,
      totalUsers:   (await pool.query("SELECT COUNT(*)::int as c FROM users")).rows[0].c,
      totalSurveys: (await pool.query("SELECT COUNT(*)::int as c FROM surveys")).rows[0].c,
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── All users with details ───────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.*,
        (u.credits - u.credits_used) as credits_remaining,
        COUNT(DISTINCT s.id)::int as survey_count,
        COUNT(DISTINCT ul.id) FILTER (WHERE ul.created_at > now()-interval '30 days')::int as actions_30d,
        SUM(ul.tokens) FILTER (WHERE ul.created_at > now()-interval '30 days')::int as tokens_30d
      FROM users u
      LEFT JOIN surveys s ON s.user_id = u.id
      LEFT JOIN usage_log ul ON ul.user_id = u.id
      GROUP BY u.id
      ORDER BY u.last_active DESC NULLS LAST
    `)
    res.json({ users: rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Update user plan ─────────────────────────────────────────────────────
router.put('/users/:id/plan', async (req, res) => {
  const { plan } = req.body
  if (!['free','premium','admin'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' })
  try {
    const defaults = { free: 3, premium: 50, admin: 999 }
    const { rows } = await pool.query(
      'UPDATE users SET plan=$1, credits=GREATEST(credits, $2) WHERE id=$3 RETURNING *',
      [plan, defaults[plan], req.params.id]
    )
    res.json({ user: rows[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Set credits for user ─────────────────────────────────────────────────
router.put('/users/:id/credits', async (req, res) => {
  const { credits } = req.body
  if (typeof credits !== 'number' || credits < 0) return res.status(400).json({ error: 'Invalid credits' })
  try {
    const { rows } = await pool.query(
      'UPDATE users SET credits=$1 WHERE id=$2 RETURNING *',
      [credits, req.params.id]
    )
    res.json({ user: rows[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Add user manually (admin creates account) ───────────────────────────
router.post('/users', async (req, res) => {
  const { email, name, plan, credits } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })
  try {
    // Create a placeholder user (firebase_uid will be set when they first login)
    const uid = 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2,8)
    const { rows } = await pool.query(`
      INSERT INTO users (firebase_uid, email, name, plan, credits)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        plan = COALESCE($4, users.plan),
        credits = GREATEST(users.credits, COALESCE($5, users.credits)),
        name = COALESCE($3, users.name)
      RETURNING *
    `, [uid, email, name || null, plan || 'premium', credits || 50])
    res.json({ user: rows[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Delete user ──────────────────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Recent activity ──────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ul.*, u.email, u.name
      FROM usage_log ul
      JOIN users u ON u.id = ul.user_id
      ORDER BY ul.created_at DESC LIMIT 100
    `)
    res.json({ activity: rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

export default router

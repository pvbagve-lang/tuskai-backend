// src/routes/auth.js
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { pool } from '../db/schema.js'

const router = Router()

// Geo lookup from IP (free, no API key needed)
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || ''
}

async function geoFromIP(ip) {
  try {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return {}
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,regionName`)
    if (!res.ok) return {}
    const data = await res.json()
    return { country: data.country || null, city: data.city || null, region: data.regionName || null }
  } catch { return {} }
}

// Called by frontend on every login — upsert user record
router.post('/sync', requireAuth, async (req, res) => {
  const { uid, email, name, photo } = req.body
  try {
    // Get geo from IP
    const ip = getClientIP(req)
    const geo = await geoFromIP(ip)

    const { rows } = await pool.query(`
      INSERT INTO users (firebase_uid, email, name, photo, country, city, region)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (firebase_uid) DO UPDATE
        SET email = EXCLUDED.email,
            name  = EXCLUDED.name,
            photo = EXCLUDED.photo,
            country = COALESCE(EXCLUDED.country, users.country),
            city    = COALESCE(EXCLUDED.city, users.city),
            region  = COALESCE(EXCLUDED.region, users.region),
            last_active = NOW()
      RETURNING *
    `, [uid, email, name, photo, geo.country, geo.city, geo.region])
    res.json({ user: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Get current user profile (includes credits)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [req.firebaseUser.uid]
    )
    if (!rows[0]) return res.status(404).json({ error: 'User not found' })
    const user = rows[0]
    res.json({
      user: {
        ...user,
        creditsRemaining: Math.max(0, (user.credits || 3) - (user.credits_used || 0)),
      }
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router

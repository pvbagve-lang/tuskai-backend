// src/middleware/user.js — attach DB user to req
import { pool } from '../db/schema.js'

export async function attachDBUser(req, res, next) {
  if (!req.firebaseUser) return next()
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [req.firebaseUser.uid]
    )
    req.dbUser = rows[0] || null
    next()
  } catch (e) {
    console.error('attachDBUser error:', e.message)
    next()
  }
}

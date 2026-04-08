// src/middleware/auth.js
import admin from 'firebase-admin'

const IS_LOCAL = process.env.NODE_ENV !== 'production' && !process.env.FIREBASE_PROJECT_ID

// Initialize Firebase Admin only in production
if (!IS_LOCAL && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  })
}

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })

  const token = authHeader.slice(7)

  // Local dev: accept dev-token-* and extract uid from it
  if (IS_LOCAL && token.startsWith('dev-token-')) {
    req.firebaseUser = { uid: token.slice(10), email: req.body?.email || 'dev@local' }
    return next()
  }

  try {
    req.firebaseUser = await admin.auth().verifyIdToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

export function requirePlan(...plans) {
  return (req, res, next) => {
    // Local dev: always allow
    if (IS_LOCAL) return next()
    const plan = req.dbUser?.plan || 'free'
    if (plans.includes(plan)) return next()
    res.status(403).json({
      error: 'upgrade_required',
      message: 'This feature requires a Premium plan',
      currentPlan: plan
    })
  }
}

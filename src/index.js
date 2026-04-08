// src/index.js — Production entry point
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { initDB } from './db/schema.js'
import authRoutes    from './routes/auth.js'
import surveyRoutes  from './routes/surveys.js'
import billingRoutes from './routes/billing.js'
import adminRoutes   from './routes/admin.js'

const app = express()

// Stripe webhook needs raw body — mount BEFORE json middleware
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))

// File upload needs raw body
app.use('/api/surveys/parse-file', express.raw({ type: '*/*', limit: '20mb' }))

app.use(helmet())
app.use(cors({
  origin: [process.env.FRONTEND_URL, 'http://localhost:5173', 'https://qualtrics.tuskresearch.ai'],
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60*1000, max: 60, message: { error: 'Too many requests' } }))
app.use('/api/surveys/build', rateLimit({ windowMs: 60*1000, max: 10, message: { error: 'Build rate limit' } }))

// Routes
app.use('/api/auth',    authRoutes)
app.use('/api/surveys', surveyRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/admin',   adminRoutes)

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString(), env: process.env.NODE_ENV || 'development' }))

// Init DB then start
const PORT = process.env.PORT || 3001
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Tusk.AI API on port ${PORT}`))
}).catch(e => { console.error('DB init failed:', e); process.exit(1) })

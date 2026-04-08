// src/routes/billing.js
import { Router } from 'express'
import Stripe from 'stripe'
import { requireAuth } from '../middleware/auth.js'
import { attachDBUser } from '../middleware/user.js'
import { pool } from '../db/schema.js'
import express from 'express'

const router = Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// Create Stripe checkout session
router.post('/checkout', requireAuth, attachDBUser, async (req, res) => {
  try {
    let customerId = req.dbUser?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.dbUser?.email,
        name:  req.dbUser?.name,
        metadata: { firebase_uid: req.firebaseUser.uid }
      })
      customerId = customer.id
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE firebase_uid=$2',
        [customerId, req.firebaseUser.uid])
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: process.env.STRIPE_PREMIUM_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/app?upgraded=true`,
      cancel_url:  `${process.env.FRONTEND_URL}/pricing`,
      metadata:    { firebase_uid: req.firebaseUser.uid }
    })
    res.json({ url: session.url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Customer portal (manage subscription)
router.post('/portal', requireAuth, attachDBUser, async (req, res) => {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   req.dbUser?.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/app`
    })
    res.json({ url: session.url })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Stripe webhook — update plan on subscription change
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event
    try {
      event = stripe.webhooks.constructEvent(
        req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch { return res.status(400).send('Webhook signature invalid') }

    const sub = event.data.object
    const uid = sub.metadata?.firebase_uid

    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated') {
      const plan = sub.status === 'active' ? 'premium' : 'free'
      if (uid) await pool.query(
        'UPDATE users SET plan=$1, stripe_sub_id=$2 WHERE firebase_uid=$3',
        [plan, sub.id, uid]
      )
    }
    if (event.type === 'customer.subscription.deleted') {
      if (uid) await pool.query(
        "UPDATE users SET plan='free', stripe_sub_id=NULL WHERE firebase_uid=$1", [uid]
      )
    }
    res.json({ received: true })
  }
)

export default router

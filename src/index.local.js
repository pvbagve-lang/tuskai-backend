// LOCAL DEV SERVER
// Run: node src/index.local.js
// No Firebase, no PostgreSQL, no Stripe needed.
// Everyone gets Premium plan automatically.

import 'dotenv/config'
import express    from 'express'
import cors       from 'cors'
import axios      from 'axios'
import { buildQSF } from './services/qsf-generator.js'
import { createRequire } from 'module'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman) and localhost variants
    const allowed = !origin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin.startsWith('http://[::1]')
    callback(null, allowed)
  },
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))

// Request timeout — prevent ECONNRESET on long AI calls
app.use((req, res, next) => {
  // 3 minute timeout for AI routes, 30s for others
  const timeout = req.path.includes('/surveys/build') || req.path.includes('/surveys/extract')
    ? 180000 : 30000
  res.setTimeout(timeout, () => {
    console.error(`⏱ Request timeout: ${req.method} ${req.path}`)
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout — try a shorter questionnaire or use the Instructions field to summarise it' })
    }
  })
  next()
})

// Request logger
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    console.log(`→ ${req.method} ${req.path}`)
  }
  next()
})

// ── In-memory stores ──────────────────────────────────────────────────────
const users   = new Map()
const surveys = []

// ── Helpers ───────────────────────────────────────────────────────────────
function getUser(req) {
  // Extract uid from Authorization header "Bearer dev-token-<uid>"
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const uid   = token.startsWith('dev-token-') ? token.slice(10) : token || 'anonymous'
  if (!users.has(uid)) {
    users.set(uid, { id: users.size + 1, uid, email: uid + '@local', plan: 'premium' })
  }
  return users.get(uid)
}

async function callClaude(apiKey, system, userMsg, maxTokens = 8000, model = 'claude-sonnet-4-6') {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key || key === 'PASTE_YOUR_KEY_HERE') {
    throw new Error('ANTHROPIC_API_KEY not set — add it to backend/.env or enter it in the app')
  }

  // Model fallback chain
  const models = [model]
  if (model === 'claude-haiku-4-5-20251001') models.push('claude-haiku-4-5', 'claude-sonnet-4-6')
  else if (model !== 'claude-sonnet-4-6') models.push('claude-sonnet-4-6')

  let lastErr = null
  for (const m of models) {
    try {
      const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
        model: m,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMsg }]
      }, {
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         key,
          'anthropic-version': '2023-06-01'
        },
        timeout: 240000
      })
      if (m !== model) console.log(`ℹ️ Fell back from ${model} to ${m}`)
      return data.content?.[0]?.text || ''
    } catch (err) {
      const apiErr = err.response?.data?.error?.message || err.response?.data?.error?.type || err.message
      const status = err.response?.status
      console.error(`❌ Anthropic API ${status}: model=${m} — ${apiErr}`)
      lastErr = { status, apiErr, model: m }
      // Only retry on 400/404 (model not found) — not on 401/429/500
      if (status !== 400 && status !== 404) break
    }
  }
  throw new Error(`Anthropic API error (${lastErr.status}): ${lastErr.apiErr}`)
}

// ── Anti-hallucination validator ─────────────────────────────────────────────
function validateGrounding(structure, sourceText) {
  if (!structure?.blocks || !sourceText) return structure

  const source = sourceText.toLowerCase()
  let grounded = 0, total = 0

  for (const block of structure.blocks) {
    for (const q of (block.questions || [])) {
      total++
      const text = (q.questionText || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')

      // Strategy 1: check DataExportTag (Q1, Q2...) appears in source
      const tag = (q.dataExportTag || '').toLowerCase()
      if (tag && source.includes(tag)) { grounded++; continue }

      // Strategy 2: check any 5+ char word from question text appears in source
      const words = text.split(' ').filter(w => w.length >= 5)
      if (words.length === 0) { grounded++; continue } // short/DB questions — assume ok
      if (words.some(w => source.includes(w))) { grounded++; continue }

      // Strategy 3: check 3-char prefix of first significant word
      const firstWord = words[0]
      if (firstWord && source.includes(firstWord.slice(0, 4))) { grounded++; continue }

      // Only flag as ungrounded if all strategies fail
      console.log(`  Unverified: "${(q.questionText||'').slice(0,60)}"`)
    }
  }

  const groundingRatio = total > 0 ? grounded / total : 1
  console.log(`Grounding check: ${grounded}/${total} questions verified (${Math.round(groundingRatio*100)}%)`)

  // Only warn if clearly hallucinated (< 30% verified AND more than 5 questions)
  if (groundingRatio < 0.20 && total > 8) {
    console.warn('⚠ LOW GROUNDING — AI may have hallucinated questions')
    structure._warning = `Only ${Math.round(groundingRatio*100)}% of generated questions could be verified against source. The AI may have hallucinated some questions. Please review carefully or try regenerating.`
  }

  return structure
}

// ── Normalize QIDs ───────────────────────────────────────────────────────────
function normalizeQIDs(structure) {
  if (!structure?.blocks) return structure

  // Build old → new QID map
  const qidMap = {}
  let counter  = 1
  for (const block of structure.blocks) {
    for (const q of (block.questions || [])) {
      const oldId = q.id || ('Q' + counter)
      const newId = 'QID' + counter
      qidMap[oldId] = newId
      // Also map common variants: QID_Q1 -> QID1, Q1 -> QID1
      const stripped = oldId.replace(/^QID_?/, '')
      qidMap['QID_' + stripped] = newId
      qidMap[stripped]          = newId
      counter++
    }
  }

  function remapQID(str) {
    if (!str) return str
    return str.replace(/QID_Q?\d+|QID\d+|Q\d+/g, m => qidMap[m] || m)
  }

  // Apply new IDs
  counter = 1
  for (const block of structure.blocks) {
    // Fix includeIf references
    for (const cond of (block.includeIf || [])) {
      if (cond.questionId) cond.questionId = qidMap[cond.questionId] || remapQID(cond.questionId)
    }
    for (const q of (block.questions || [])) {
      q.id = 'QID' + counter++

      // Fix displayLogic
      for (const cond of (q.displayLogic?.conditions || [])) {
        if (cond.questionId) cond.questionId = qidMap[cond.questionId] || remapQID(cond.questionId)
      }
      // Fix skipLogic
      for (const rule of (q.skipLogic?.rules || [])) {
        if (rule.destinationQid) rule.destinationQid = qidMap[rule.destinationQid] || remapQID(rule.destinationQid)
      }
    }
  }

  // Fix surveyFlow branch conditions AND BranchLogic
  function fixFlow(flow) {
    for (const f of (flow || [])) {
      // Fix simple condition object
      if (f.condition?.questionId) {
        f.condition.questionId = qidMap[f.condition.questionId] || remapQID(f.condition.questionId)
      }
      // Fix BranchLogic object (Qualtrics format)
      const bl = f.BranchLogic || {}
      for (const gk of Object.keys(bl)) {
        if (gk === 'Type') continue
        const grp = bl[gk]
        if (typeof grp !== 'object') continue
        for (const ek of Object.keys(grp)) {
          if (ek === 'Type') continue
          const expr = grp[ek]
          if (typeof expr !== 'object') continue
          for (const field of ['QuestionID','QuestionIDFromLocator']) {
            if (expr[field]) expr[field] = qidMap[expr[field]] || remapQID(expr[field])
          }
          for (const field of ['ChoiceLocator','LeftOperand']) {
            if (expr[field]) expr[field] = expr[field].replace(/QID_[A-Za-z0-9]+/g,
              m => qidMap[m] || qidMap[m.replace('QID_','')] || m)
          }
        }
      }
      fixFlow(f.flow)
    }
  }
  fixFlow(structure.surveyFlow)

  // Remove Options from Standard blocks (causes Qualtrics import failure)
  for (const block of (structure.blocks || [])) {
    if (block.options) delete block.options
    if (block.Options) delete block.Options
  }

  return structure
}

// ── File parsing helper ──────────────────────────────────────────────────────
// ── FLOW OUTLINE parser ──────────────────────────────────────────────────────
// Parses the FLOW: OUTLINE YAML-like section into structured flow items
function parseFlowOutline(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  // Find FLOW: OUTLINE section
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^FLOW:\s*OUTLINE/i.test(lines[i])) { start = i + 1; break }
  }
  if (start === -1) return null

  // Find end of flow section (next major section like "Blocks &")
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (/^(Blocks\s*&|Blocks and Questions|Q:|DESCRIPTIVE|id:)/i.test(lines[i])) { end = i; break }
  }

  const flowLines = lines.slice(start, end)
  const flowItems = []
  let i = 0

  while (i < flowLines.length) {
    const line = flowLines[i]

    // Block reference: - block: "Name"
    const blockM = /^-\s*block:\s*["']?([^"']+)["']?/.exec(line)
    if (blockM) {
      flowItems.push({ type: 'Block', name: blockM[1].trim() })
      i++; continue
    }

    // Branch: - type: "branch" followed by if: "condition"
    const branchM = /^-\s*type:\s*["']?branch["']?/i.exec(line)
    if (branchM) {
      // Look ahead for if: condition
      let condition = '', endingType = 'Default', messageId = '', hasEndSurvey = false
      let j = i + 1
      while (j < flowLines.length) {
        const fl = flowLines[j]
        // Stop at next branch or block (but not end_survey which is inside this branch)
        if (/^-\s*type:\s*["']?branch["']?/i.test(fl)) break
        if (/^-\s*block:/i.test(fl)) break
        const ifM    = /^if:\s*["']?(.+?)["']?\s*$/.exec(fl)
        const endM   = /^ending_type:\s*["']?(.+?)["']?/.exec(fl)
        const msgM   = /^message_id:\s*["']?(.+?)["']?/.exec(fl)
        const esM    = /^-\s*type:\s*["']?end_survey["']?/i.test(fl)
        if (ifM)  condition   = ifM[1].trim()
        if (endM) endingType  = endM[1].trim()
        if (msgM) messageId   = msgM[1].trim()
        if (esM)  { hasEndSurvey = true; j++; break }
        j++
      }
      if (condition) {
        flowItems.push({
          type:        'Branch',
          condition,
          action:      hasEndSurvey ? 'EndSurvey' : 'Continue',
          endingType,
          messageId
        })
      }
      i = j; continue
    }

    // End survey
    if (/^-\s*type:\s*["']?end_survey["']?/i.test(line)) {
      flowItems.push({ type: 'EndSurvey' })
      i++; continue
    }

    // Group (treat as transparent — just continue into its children)
    if (/^-\s*type:\s*["']?group["']?/i.test(line)) { i++; continue }
    if (/^flow:/.test(line)) { i++; continue }

    i++
  }

  return flowItems
}

// Convert FLOW OUTLINE items to Qualtrics surveyFlow branches
function flowOutlineToSurveyFlow(flowItems, blockDescMap, qidLookup) {
  // blockDescMap: { "Demographics": "BL_001", ... }
  const flow        = []
  const terminated  = [] // collect all terminate branches

  for (const item of flowItems) {
    if (item.type === 'Block') {
      const bid = blockDescMap[item.name]
      if (bid) flow.push({ type: 'Block', id: bid })
      else     console.log(`  Flow: block "${item.name}" not found in blocks`)
    }
    else if (item.type === 'Branch' && item.action === 'EndSurvey') {
      const conditions = parseShowIf(item.condition, qidLookup)
      if (conditions.length > 0) {
        flow.push({
          type:      'Branch',
          condition: conditions[0],             // use first condition for branch
          conditions,                            // all conditions
          flow:      [{ type: 'EndSurvey', endingType: item.endingType || 'Default', messageId: item.messageId }]
        })
      }
    }
    else if (item.type === 'EndSurvey') {
      flow.push({ type: 'EndSurvey' })
    }
  }

  return flow
}

// ── SHOW IF / routing expression parser ──────────────────────────────────────
function splitOrParts(expr) {
  // Split on ' or ' only when outside quotes/parens
  const parts = []
  let depth = 0, inQ = null, cur = [], i = 0
  while (i < expr.length) {
    const c = expr[i]
    if ((c === '"' || c === "'") && !inQ)       { inQ = c; cur.push(c) }
    else if (c === inQ && inQ)                   { inQ = null; cur.push(c) }
    else if (c === '(' && !inQ)                  { depth++; cur.push(c) }
    else if (c === ')' && !inQ)                  { depth--; cur.push(c) }
    else if (!inQ && !depth && expr.slice(i, i+4).toLowerCase() === ' or ') {
      parts.push(cur.join('').trim()); cur = []; i += 4; continue
    } else { cur.push(c) }
    i++
  }
  if (cur.length) parts.push(cur.join('').trim())
  return parts.filter(p => p)
}

function parseShowIf(expr, qidLookup) {
  const parts      = splitOrParts(expr.trim())
  const conditions = []

  parts.forEach((part, i) => {
    const connector = i < parts.length - 1 ? 'Or' : 'And'
    part = part.trim()

    // selected(Qn, 'value') or not_selected(Qn, 'value')
    let m = /^(not_selected|selected)\(([A-Za-z0-9_]+),\s*['"](.+?)['"]\)$/i.exec(part)
    if (m) {
      const qid = qidLookup[m[2]] || m[2]
      conditions.push({ questionId: qid, choiceText: m[3],
        operator: m[1].toLowerCase() === 'selected' ? 'Selected' : 'NotSelected',
        logicType: 'Question', connector })
      return
    }

    // displayed(Qn)
    m = /^displayed\(([A-Za-z0-9_]+)\)$/i.exec(part)
    if (m) {
      const qid = qidLookup[m[1]] || m[1]
      conditions.push({ questionId: qid, operator: 'Displayed', logicType: 'Question', connector })
      return
    }

    // greater_than / less_than / equal_to (Qn, value)
    m = /^(greater_than|less_than|greater_than_or_equal|less_than_or_equal|equal_to)\(([A-Za-z0-9_]+),\s*(.+?)\)$/i.exec(part)
    if (m) {
      const opMap = { greater_than:'GreaterThan', less_than:'LessThan',
        greater_than_or_equal:'GreaterThanOrEqual', less_than_or_equal:'LessThanOrEqual', equal_to:'EqualTo' }
      const qid = qidLookup[m[2]] || m[2]
      conditions.push({ questionId: qid, operator: opMap[m[1].toLowerCase()] || 'GreaterThan',
        value: m[3].trim().replace(/['"]/g,''), logicType: 'Question', connector })
      return
    }

    // field == 'value' or field != 'value'
    m = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(==|!=)\s*['"](.+?)['"]$/.exec(part)
    if (m) {
      const op = m[2] === '==' ? 'EqualTo' : 'NotEqualTo'
      if (qidLookup[m[1]]) {
        conditions.push({ questionId: qidLookup[m[1]], choiceText: m[3], operator: op, logicType: 'Question', connector })
      } else {
        conditions.push({ field: m[1], value: m[3], operator: op, logicType: 'EmbeddedField', connector })
      }
      return
    }

    // contains(field, 'value')
    m = /^contains\(([A-Za-z0-9_]+),\s*['"](.+?)['"]\)$/i.exec(part)
    if (m) {
      if (qidLookup[m[1]]) {
        conditions.push({ questionId: qidLookup[m[1]], choiceText: m[2], operator: 'Selected', logicType: 'Question', connector })
      } else {
        conditions.push({ field: m[1], value: m[2], operator: 'Contains', logicType: 'EmbeddedField', connector })
      }
      return
    }
  })

  return conditions
}

// Apply parsed SHOW IF conditions to structure questions
function applyShowIfToStructure(structure) {
  // Build tag→qid lookup from structure
  const qidLookup = {}
  structure.blocks.forEach(b => b.questions?.forEach(q => {
    if (q.dataExportTag) qidLookup[q.dataExportTag] = q.id
  }))

  let applied = 0
  structure.blocks.forEach(b => {
    b.questions?.forEach(q => {
      const routing = q._srcRouting || []
      for (const rule of routing) {
        // SHOW IF → displayLogic
        const showM = /^SHOW IF:\s*(.+)$/i.exec(rule)
        if (showM) {
          const conditions = parseShowIf(showM[1], qidLookup)
          if (conditions.length > 0) { q.displayLogic = { conditions }; applied++ }
        }
        // TERMINATE_IF_SELECTED → skipLogic EndOfSurvey
        const termM = /^TERMINATE_IF_SELECTED:\s*(.+)$/.exec(rule)
        if (termM) {
          const choiceText  = termM[1].trim()
          const choiceIndex = (q.choices || []).indexOf(choiceText) + 1
          if (!q.skipLogic) q.skipLogic = { rules: [] }
          q.skipLogic.rules.push({
            choiceIndex:     choiceIndex || 1,
            choiceText,
            operator:        'Selected',
            destination:     'EndOfSurvey',
            destinationType: 'EndOfSurvey'
          })
          applied++
        }
      }
    })
  })

  console.log(`applyShowIfToStructure: ${applied} questions got displayLogic`)
  return structure
}

// Parse embedded data variables from questionnaire spec
function parseEmbeddedData(text) {
  const lines  = text.split('\n').map(l => l.trim()).filter(l => l)
  const fields = []
  let   inED   = false

  for (const line of lines) {
    if (/^Embedded Data Defaults:/i.test(line)) { inED = true; continue }
    if (inED) {
      // Stop at next section header
      if (/^(Survey Brief|Assets|Flow Overview|Blocks|Q:|SECTION)/i.test(line)) break

      // Parse: "field_name  |  type: Custom  |  variable_type: String  |  value: X"
      const parts  = line.split('|').map(p => p.trim())
      if (parts.length >= 2) {
        const name  = parts[0].trim()
        const vType = (parts.find(p => /variable_type:/i.test(p)) || '').replace(/variable_type:\s*/i,'').trim() || 'String'
        const rawVal= (parts.find(p => /^value:/i.test(p)) || '').replace(/^value:\s*/i,'').trim()
        const value = (rawVal === '(computed)' || rawVal === '') ? '' : rawVal

        if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          fields.push({ name, type: 'Custom', variableType: vType, value })
        }
      }
    }
  }
  return fields
}

// Detect questionnaire format and parse accordingly
function detectFormat(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  // ── Structured spec (Qualtrics-export style) ──
  const hasQColon = lines.some(l => /^Q:\s+.+\(Q\d+\)/i.test(l) || /^Q:\s+.+\([A-Za-z_]+\)/i.test(l))
  const hasIdLine = lines.some(l => /^id:\s*[A-Za-z]/i.test(l))
  if (hasQColon && hasIdLine) return 'structured-spec'

  // ── Count hits for each pattern family ──
  let qPrefix = 0, numTitled = 0, capsTitle = 0, plainNum = 0, baseAsk = 0

  for (const l of lines) {
    const cl = l.replace(/~~/g, '').trim()
    if (!cl) continue
    // Q1. / Q1: / Q1) / Q1a. / S1. etc
    if (/^[QqSs]\d+[a-z]?\s*[.):\s\-–—]/i.test(cl)) qPrefix++
    // 3.  UPPERCASE TITLE
    if (/^\d{1,3}\.\s+[A-Z][A-Z\s\-–—&/,()]{2,}/.test(cl)) numTitled++
    // CAPS TITLE [AUDIENCE]
    if (/^[A-Z][A-Z\s\-–—&/,()]{2,}\s*\[/.test(cl)) capsTitle++
    // Plain numbered: 1. long text
    if (/^\d{1,3}[.)]\s+.{25,}/.test(cl)) plainNum++
    // ASK ALL / BASE: patterns (Ipsos/Kantar style)
    if (/^(?:ASK\s+|BASE:\s*|SHOW\s+IF)/i.test(cl)) baseAsk++
  }

  if (qPrefix >= 3) return 'simple'
  if (numTitled >= 3 || capsTitle >= 3) return 'simple'
  if (baseAsk >= 3) return 'simple'
  if (plainNum >= 5) return 'simple'
  return 'simple' // default — the parser handles all sub-formats
}

function parseStructuredSpec(text) {
  // Parse Qualtrics-style spec format:
  // Q: Title (Q1) / MULTIPLE CHOICE | SAVR / id: Q1 / Question text / 1. Choice / SHOW IF: ...
  const lines  = text.split('\n').map(l => l.trim()).filter(l => l)
  const sections = []
  let curSec   = { name: 'Main Survey', questions: [], routing: [] }
  let curQ     = null
  let state    = 'seeking' // seeking | in_q_header | in_question

  const Q_HDR  = /^Q:\s+.+\(([A-Za-z0-9_]+)\)\s*$/i   // Q: Title (Q1)
  const ID_LINE= /^id:\s*([A-Za-z0-9_]+)/i                // id: Q1
  const TYPE_LN= /^(?:MULTIPLE CHOICE|SINGLE|TEXT ENTRY|MATRIX|DESCRIPTIVE|SIDE BY SIDE|SLIDER)/i
  const CHOICE = /^(\d+)\.\s+(.+)/                      // 1. Choice text
  const SHOW_IF= /^SHOW IF:\s*(.+)/i
  const SKIP_LN= /^(?:Randomization:|Validation:|Export:|Anchor|Exclusive|BLOCK SETTINGS|questions_per)/i
  const META_LN= /^(?:intent:|data_use:|builder_notes:|Survey ID|Language:|Version:|Owner:|Embedded|Survey Brief|Audience:|Purpose:|Tone:|Must_cover:|Assets|Message|Branding|Company|Selection|Flow |FLOW:|flow:|\- block:|\- type:|if:|ending_|Blocks &)/i
  // Section detection: build a set of lines that precede "intent:" or "Q:" lines
  // These are the section header lines
  const sectionHeaders = new Set()
  for (let si = 0; si < lines.length - 1; si++) {
    const next = lines[si + 1]
    if (/^(intent:|Q:\s)/i.test(next) || (si + 2 < lines.length && /^(intent:|Q:\s)/i.test(lines[si + 2]))) {
      const l = lines[si]
      if (l.length > 1 && l.length < 60 && /^[A-Z][A-Za-z0-9\s&\/()-]+$/.test(l)
          && !/^(Q:|id:|SHOW|SKIP|TERMINATE|Validation|Export|Anchor|Random|\d+\.|\+|Block|MULTIPLE|TEXT ENTRY|MATRIX|SIDE|SLIDER|DESCRIPTIVE)/i.test(l)) {
        sectionHeaders.add(l)
      }
    }
  }
  const SEC_LN = { test: (l) => sectionHeaders.has(l) }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Skip pure metadata
    if (META_LN.test(line)) continue
    if (SKIP_LN.test(line)) continue

    // Section header (non-question group names)
    const qhdr = Q_HDR.exec(line)
    if (qhdr) {
      if (curQ) { curSec.questions.push(curQ); curQ = null }
      // The ID and question text come in next few lines
      const tmpId = qhdr[1]
      curQ = { id: tmpId, text: '', choices: [], routing: [], multiSelect: false, isDescriptive: /DESCRIPTIVE/i.test(lines[i+1]||'') }
      state = 'in_q_header'
      continue
    }

    // Inside a question
    if (curQ) {
      const idM = ID_LINE.exec(line)
      if (idM) { curQ.id = idM[1].toUpperCase(); continue }
      if (TYPE_LN.test(line)) {
        curQ.multiSelect = /MAVR|Multi-select|SELECT ALL/i.test(line)
        curQ.isDescriptive = /DESCRIPTIVE|DB/i.test(line)
        continue
      }
      const choiceM = CHOICE.exec(line)
      if (choiceM) {
        const raw2  = choiceM[2]
        const clean = raw2.replace(/\s*\(please specify\)/gi,'').replace(/\s*\[(?!TERMINATE)[^\]]*\]/gi,'').trim()
        if (clean && clean !== '+') {
          // Detect [TERMINATE] on numbered choice
          if (/\[TERMINATE\]/i.test(raw2)) {
            const ct = raw2.replace(/\s*\[TERMINATE\]/i,'').trim()
            if (ct) { curQ.choices.push(ct); curQ.routing.push('TERMINATE_IF_SELECTED: ' + ct) }
          } else {
            curQ.choices.push(clean)
          }
        }
        continue
      }
      if (line === '+ Other (open text)') { curQ.hasOther = true; continue }
      const showM = SHOW_IF.exec(line)
      if (showM) { curQ.routing.push('SHOW IF: ' + showM[1]); continue }
      // Question text: non-empty line that isn't a choice or metadata
      if (!curQ.text && line.length > 10 && !SKIP_LN.test(line) && !TYPE_LN.test(line)) {
        curQ.text = line
      }
    } else if (SEC_LN.test(line) && !Q_HDR.test(line)) {
      // Section name
      if (curSec.questions.length > 0) sections.push(curSec)
      curSec = { name: line, questions: [], routing: [] }
    }
  }

  if (curQ) curSec.questions.push(curQ)
  if (curSec.questions.length > 0) sections.push(curSec)

  // If no sections found, put everything in one block
  if (sections.length === 0 && curSec.questions.length > 0) sections.push(curSec)

  return sections
}

// Pure JS DOCX text extractor — no dependencies needed
// DOCX = ZIP archive containing word/document.xml with <w:t> tags
function extractDocxText(buffer) {
  try {
    // Find PK (ZIP) signature and locate word/document.xml
    // Simple approach: find all <w:t> content using regex on the buffer
    let content = ''

    // DOCX ZIP contains XML files. We look for the document.xml entry.
    // Find 'word/document.xml' in the ZIP local file headers
    const bufStr = buffer.toString('binary')
    let xmlStart = -1

    // Search for word/document.xml entry
    const target = 'word/document.xml'
    let pos = 0
    while (pos < bufStr.length - target.length) {
      if (bufStr.slice(pos, pos + 4) === 'PK\x03\x04') {
        // Local file header found
        const fnLen  = bufStr.charCodeAt(pos + 26) + bufStr.charCodeAt(pos + 27) * 256
        const exLen  = bufStr.charCodeAt(pos + 28) + bufStr.charCodeAt(pos + 29) * 256
        const fname  = bufStr.slice(pos + 30, pos + 30 + fnLen)
        if (fname === target) {
          xmlStart = pos + 30 + fnLen + exLen
          break
        }
        pos += 30 + fnLen + exLen
      } else { pos++ }
    }

    if (xmlStart === -1) {
      // Try finding XML content directly
      const xmlIdx = bufStr.indexOf('<?xml')
      if (xmlIdx !== -1) content = bufStr.slice(xmlIdx)
      else return null
    } else {
      content = bufStr.slice(xmlStart)
    }

    // Extract text from <w:t> tags and paragraph breaks
    const lines = []
    let   cur   = ''

    const wt_re  = /<w:t[^>]*>([^<]*)<\/w:t>/g
    const br_re  = /<w:p[ >]/g
    let   m

    // Process paragraph by paragraph
    const paras = content.split(/<w:p[ >]/)
    for (const para of paras) {
      const words = []
      while ((m = wt_re.exec(para)) !== null) {
        if (m[1]) words.push(m[1])
      }
      const line = words.join('').trim()
      if (line) lines.push(line)
      wt_re.lastIndex = 0
    }

    return lines.join('\n')
  } catch(e) {
    return null
  }
}

async function extractTextFromFile(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase()

  if (ext === 'docx') {
    // Try mammoth first (best quality)
    try {
      const { createRequire } = await import('module')
      const req    = createRequire(import.meta.url)
      const mammoth = req('mammoth')
      const result  = await mammoth.extractRawText({ buffer })
      const text    = result.value
      return { text, pages: 1, method: 'mammoth', chars: text.length }
    } catch(mammothErr) {
      // Mammoth not installed — use built-in ZIP+XML parser (no deps needed)
      try {
        const { unzipSync } = await import('zlib')
        const { promisify } = await import('util')
        const unzip = promisify(unzipSync)

        // DOCX is a ZIP — find word/document.xml
        // Use a simple ZIP parser since we have the buffer
        const text = extractDocxText(buffer)
        if (text && text.length > 20) {
          return { text, pages: 1, method: 'docx-xml', chars: text.length }
        }
      } catch(zipErr) {}

      // Last resort: try reading as UTF-8 with XML tag stripping
      const raw  = buffer.toString('utf8')
      const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, '\n').trim()
      return { text, pages: 1, method: 'raw-stripped', warning: 'mammoth not installed — using fallback parser' }
    }
  }

  if (ext === 'pdf') {
    try {
      const { createRequire } = await import('module')
      const req    = createRequire(import.meta.url)
      // Try pdf-parse if available
      const pdf    = req('pdf-parse')
      const result = await pdf(buffer)
      return { text: result.text, pages: result.numpages, method: 'pdf-parse' }
    } catch(e) {
      return { text: buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\t]/g, ' '), pages: 1, method: 'raw-pdf', warning: 'pdf-parse not installed' }
    }
  }

  if (ext === 'xlsx' || ext === 'xls') {
    try {
      const { createRequire } = await import('module')
      const req  = createRequire(import.meta.url)
      const XLSX = req('xlsx')
      const wb   = XLSX.read(buffer, { type: 'buffer' })
      const lines = []
      wb.SheetNames.forEach(name => {
        lines.push('=== Sheet: ' + name + ' ===')
        lines.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]))
      })
      return { text: lines.join('\n'), pages: wb.SheetNames.length, method: 'xlsx' }
    } catch(e) {
      return { text: '', pages: 0, method: 'failed', warning: 'xlsx not installed: ' + e.message }
    }
  }

  if (ext === 'txt' || ext === 'md' || ext === 'csv') {
    const text = buffer.toString('utf8')
    return { text, pages: 1, method: 'text', chars: text.length }
  }

  return { text: buffer.toString('utf8'), pages: 1, method: 'raw' }
}

// ── Text compression ─────────────────────────────────────────────────────────
function compressQuestionnaire(text, maxChars = 8000) {
  if (!text) return ''

  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  // Smart start: skip metadata headers (flow outline, embedded data, survey brief etc.)
  // Look for first line that looks like a real question definition
  let startIdx = 0
  const questionMarkers = [
    /^Q:\s/i,           // "Q: Question Title"
    /^id:\s*(Q|S|intro|screen)/i, // "id: Q1"
    /^\*\*[QqSs]\d/,   // "**Q1.**"
    /^[QqSs]\d+[.)]/,   // "Q1." or "S1)"
    /^SECTION \d/i,      // "SECTION 1:"
    /^#{1,3}\s*(Q|S)\d/,// "## Q1"
  ]
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    if (questionMarkers.some(re => re.test(lines[i]))) {
      // Go back a few lines to include section header
      startIdx = Math.max(0, i - 2)
      break
    }
  }

  // Take from question start, skip pure metadata lines
  const metadataPatterns = [
    /^(Survey ID|Language|Version|Owner|Embedded Data|state|region|msa|cbsa|roofing_buyer|siding_buyer):/i,
    /^(variable_type|value:|type: Custom)/i,
    /^(Survey Brief|Audience:|Purpose:|Tone:|Must_cover:|Avoid:|Incentive:|Privacy:|Success_metric:)/i,
    /^(Assets|Message IDs:|Branding:|Company Lists:|Selection Criteria:)/i,
    /^(Flow Overview|FLOW: OUTLINE|flow:|\- block:|\- type:|if:|ending_type:|message_id:)/i,
    /^intent:|^data_use:|^show_if:/i,
  ]

  const meaningfulLines = lines.slice(startIdx).filter(l =>
    !metadataPatterns.some(re => re.test(l))
  )

  let compressed = meaningfulLines.join('\n')

  // Remove excessive blank content
  compressed = compressed.replace(/\n{3,}/g, '\n\n')

  // If still too long, keep first 70% + last 15% (demographics usually at end)
  if (compressed.length > maxChars) {
    const keep70 = Math.floor(maxChars * 0.75)
    const keep15 = Math.floor(maxChars * 0.15)
    const mid    = `\n\n...[${Math.round((compressed.length - keep70 - keep15) / 100) * 100} chars of middle section omitted — describe any missing sections in Instructions]...\n\n`
    compressed   = compressed.slice(0, keep70) + mid + compressed.slice(-keep15)
  }

  return compressed
}

// Count approximate tokens (1 token ≈ 4 chars)
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4)
}

// Split questionnaire into chunks of ~N questions for large surveys
function splitIntoChunks(text, questionsPerChunk = 12) {
  const lines  = text.split('\n')
  const chunks = []
  let current  = []
  let qCount   = 0

  for (const line of lines) {
    current.push(line)
    // Detect question markers: Q1., S1., **Q1**, etc.
    if (/^\s*(\*\*)?[QqSs]\d+[.)]/i.test(line) || /^\s*\d+\.\s+[A-Z]/i.test(line)) {
      qCount++
      if (qCount > 0 && qCount % questionsPerChunk === 0) {
        chunks.push(current.join('\n'))
        current = []
      }
    }
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks.filter(c => c.trim())
}

// ── Logic rule verifier ──────────────────────────────────────────────────────
function verifyLogicRules(logicMap, sourceText) {
  if (!logicMap?.rules?.length || !sourceText) return logicMap

  const src = sourceText.toLowerCase()
  const verified = []
  const flagged  = []

  for (const rule of logicMap.rules) {
    const issues = []

    // Check choice text appears in source (skip sourceQuestion check — numbering formats vary too much)
    const choiceText = rule.condition?.choiceText || ''
    if (choiceText && choiceText.length > 3) {
      const choiceWords = choiceText.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w=>w.length>4)
      const choiceFound = choiceWords.length === 0 || choiceWords.some(w => src.includes(w))
      if (!choiceFound) issues.push(`choiceText "${choiceText}" not grounded in source`)
    }

    if (issues.length > 0) {
      flagged.push({ ...rule, confidence: 'Low', notes: (rule.notes ? rule.notes + '; ' : '') + 'Verify: ' + issues.join(', ') })
    } else {
      verified.push({ ...rule, confidence: rule.confidence === 'Low' ? 'Medium' : rule.confidence })
    }
  }

  console.log(`Logic verify: ${verified.length} ok, ${flagged.length} flagged`)
  return { ...logicMap, rules: [...verified, ...flagged] }
}

// ── Exclusive choices + anchors handler ──────────────────────────────────────
function applyChoiceFlags(choices, choiceOrder, sourceSpec) {
  // sourceSpec: array of {text, exclusive, anchor, textEntry}
  if (!sourceSpec?.length) return { choices, choiceOrder }

  const newChoices = {}
  const newOrder   = []

  // Separate anchored (bottom) choices
  const normal   = sourceSpec.filter(c => !c.anchor)
  const anchored = sourceSpec.filter(c => c.anchor)
  const ordered  = [...normal, ...anchored]

  ordered.forEach((c, i) => {
    const key   = String(i + 1)
    const entry = { Display: typeof c === 'string' ? c : (c.text || c.Display || '') }
    if (c.exclusive) entry.ExclusiveAnswer = true
    if (c.textEntry)  entry.TextEntry       = true
    newChoices[key] = entry
    newOrder.push(i + 1)
  })

  return { choices: newChoices, choiceOrder: newOrder }
}

// ── Piped text resolver ───────────────────────────────────────────────────────
function resolvePipedText(text, embeddedDataMap) {
  if (!text) return text
  // ${variable_name} → Qualtrics embedded data pipe: ${e://Field/variable_name}
  return text.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    // Check if it's a known embedded data field
    const cleanVar = varName.trim()
    return '${e://Field/' + cleanVar + '}'
  })
}

// ── Loop & Merge block builder ────────────────────────────────────────────────
function buildLoopMergeBlock(loopBlock, qidOrder) {
  // Loop & Merge: Qualtrics uses a special block with Looping settings
  // sourceQid: the multi-select question whose choices drive the loop
  const loopSourceQid = loopBlock.loopSourceQid
  if (!loopSourceQid) return null

  const srcIdx = qidOrder[loopSourceQid]
  const srcQid = srcIdx !== undefined ? 'QID' + (srcIdx + 1) : loopSourceQid

  return {
    Type: 'Standard',
    SubType: '',
    Description: loopBlock.description || 'Loop Block',
    ID: loopBlock.id,
    Options: {
      Looping: 'Question',
      LoopingQuestionID: srcQid,
    },
    BlockElements: []  // filled by caller
  }
}


// ── Deterministic questionnaire parser ────────────────────────────────────────
function parseQuestionnaire(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l)

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPREHENSIVE MR QUESTIONNAIRE PARSER
  // Handles: Ipsos, Kantar, Nielsen, WPP agencies, Qualtrics, SurveyMonkey,
  //          Confirmit/Forsta, Decipher, SPSS-style, academic, brand equity,
  //          ad-hoc, tracker, U&A, concept test formats
  // ═══════════════════════════════════════════════════════════════════════════

  // ── QUESTION ID PATTERNS (Priority order) ────────────────────────────────
  const Q_PREFIX  = /^(?:\*\*)?([QqSs]\d+[a-z]?)[.):\s\-–—]+(?:\*\*)?\s*(.+)/
  const Q_PREFIX2 = /^(?:\*\*)?[Qq][.\s]+(\d+[a-z]?)[.):\s\-–—]+(?:\*\*)?\s*(.+)/
  const Q_SOLO    = /^(?:\*\*)?([QqSs]\d+[a-z]?)\s*[.):\-]*\s*(?:\*\*)?$/
  const NUM_TITLED= /^(\d{1,3})\.\s+([A-Z][A-Z\s\-–—&/,()]{2,})/
  const CAPS_TITLE= /^([A-Z][A-Z\d\s\-–—&/,()]{2,})\s*\[([^\]]+)\]/
  // CAPS title WITHOUT bracket: "AGE – For All", "MONTHLY HOUSEHOLD INCOME – For All"
  const CAPS_TITLE2= /^([A-Z][A-Z\s\-–—&/,()]{3,})\s*[–—\-]\s*(?:For All|OPEN END|PATIENTS?|HCPs?|ALL|PARTNERS?)/i
  const BRACKET_Q = /^\[([QqSs]?\d+[a-z]?)\]\s*(.+)/
  const PIPE_Q    = /^([QqSs]\d+[a-z]?)\|(\w+)\|/
  const NUM_LONG  = /^(\d{1,3})[.)]\s+(.{25,})/
  const BASE_Q    = /^(?:ASK\s+(?:ALL|IF)|BASE:\s*|SHOW\s+(?:IF|TO|ONLY))\s*[—–\-:]?\s*(?:([QqSs]\d+[a-z]?)\.?\s*)?(.+)?/i

  // ── SECTION PATTERNS ─────────────────────────────────────────────────────
  const SEC_PAT = /^(?:#{1,3}\s*)?(?:Section\s+\w+[:\s\-–—]*(.+)|SECTION\s+\w+[:\s\-–—]*(.+)|(?:SCREENER|DEMOGRAPHICS|MAIN\s*(?:SURVEY|QUESTIONNAIRE|SECTION)|MODULE\s+\w+|PART\s+\w+|BLOCK\s+\w+|WARM[\s-]*UP|CLASSIFICATION|PROFILING|BRAND\s+(?:EQUITY|AWARENESS|HEALTH|METRICS)|CONCEPT\s+TEST|AD\s+TEST|PRODUCT\s+TEST|USAGE\s*(?:&|AND)\s*ATTITUDES?|CUSTOMER\s+(?:SATISFACTION|EXPERIENCE)|NPS\s+SECTION|LOYALTY|CLOSING\s+SECTION)[:\s\-–—]*(.*))/i
  const ASK_PAT = /^(?:ASK\s+ALL|BASE:\s*ALL\s*(?:RESPONDENTS?)?|ALL\s+RESPONDENTS?)\s*$/i

  // ── SKIP / META PATTERNS ─────────────────────────────────────────────────
  const SKIP_PAT = /^(?:Test Questionnaire|Client:|Purpose:|Target Audience:|Target:|END OF SURVEY|Routing &|RESEARCH OBJECTIVE|METHODOLOGY|SAMPLE (?:DESIGN|CONSIDERATION)|EXPLANATORY NOTE|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|Page \d|\[INSERT\s|Ready\?|Thank you(?:\s+for)?|INTERVIEWER|SHOWCARD|CARD\s+\d|NOTE TO)/i

  // ── ROUTING PATTERNS ─────────────────────────────────────────────────────
  const RT_PAT = /^(?:IF\s|ONLY\s+SHOW|SHOW\s+IF|SKIP\s+TO|TERMINATE\s+(?:IF|THE|SURVEY)|GO\s*TO|GOTO|\[LOOP|\[END\s+LOOP|PIPE\s+IN|PLEASE\s+TERMINATE|FILTER:|LOGIC:|CONDITION:|BRANCH\s+(?:TO|IF)|ROUTE\s+TO|DISPLAY\s+IF|HIDE\s+IF|AUTO-?PUNCH|CARRY\s+FORWARD|MASK|EXCLUSIVE|ANCHOR|RANDOMIZE|ROTATE|PIPING)/i

  // ── CHOICE PATTERNS ──────────────────────────────────────────────────────
  const BULLET     = /^[-•*●○▪▸►]\s*(.+)|^[a-z][.)]\s+(.+)/i
  const NUM_CHOICE = /^(\d{1,3})[.)]\s+(.{1,200})$/
  const TBL_CHOICE = /^(\d{1,2})\s{2,}(.+?)(?:\s{2,}(?:CONTINUE|TERMINATE|CLOSE|GO TO|SKIP))?\s*$/i
  const CODED_CHOICE = /^(?:0?(\d{1,2}))\s*[.)\-–]\s*(.{2,120})$/

  // ── STRIKETHROUGH & INSTRUCTION ──────────────────────────────────────────
  const STRIKE_FULL = /^~~.+~~$/
  const PROG_INST   = /^(?:PROGRAM(?:ME)?\s+INSTRUCTIONS?|CODING INSTRUCTIONS?|SCRIPTER\s+(?:NOTES?|INSTRUCTIONS?)|DP\s+(?:NOTES?|INSTRUCTIONS?)|ROUTING\s+INSTRUCTIONS?)/i

  // ── QUESTION TYPE DETECTION ──────────────────────────────────────────────
  const TYPE_HINTS = {
    NPS:     /\b(?:NPS|Net Promoter|recommend.*(?:0|10).*scale|likely.*recommend)\b/i,
    Matrix:  /\b(?:grid|matrix|battery|rate\s+(?:each|the\s+following)|using\s+(?:the\s+)?scale|for\s+each.*(?:following|statement)|(?:agree|disagree).*scale)\b/i,
    Slider:  /\b(?:slider|drag|thermometer|scale\s+(?:from|of)\s+\d+\s+to\s+\d+)\b/i,
    TE:      /\b(?:open\s*-?\s*end|verbatim|type\s+in|write\s+in|please\s+(?:specify|describe|explain|type|write|enter)|in\s+your\s+own\s+words|free\s+text|text\s+(?:box|entry)|OE\b)\b/i,
    RO:      /\b(?:rank|ranking|rank\s+(?:order|in\s+order|from)|most\s+(?:to|important).*least)\b/i,
    CS:      /\b(?:constant\s+sum|allocat|distribut.*(?:100|10)\s*(?:points?|tokens?))\b/i,
    MaxDiff: /\b(?:maxdiff|max\s*-?\s*diff|best.*worst|most.*least\s+(?:appealing|important))\b/i,
    DB:      /\b(?:descriptive\s+text|intro(?:duction)?\s+text|welcome|thank\s+you|end\s+(?:message|screen)|information\s+screen)\b/i,
  }
  function detectQType(txt) {
    for (const [type, pat] of Object.entries(TYPE_HINTS)) { if (pat.test(txt)) return type }
    return null
  }

  // Helper: check if line is a new question
  function isQuestionLine(cl) {
    return Q_PREFIX.test(cl) || Q_PREFIX2.test(cl) || Q_SOLO.test(cl) ||
           (NUM_TITLED.test(cl) && parseInt(NUM_TITLED.exec(cl)[1]) <= 100) ||
           CAPS_TITLE.test(cl) || CAPS_TITLE2.test(cl) || BRACKET_Q.test(cl) || PIPE_Q.test(cl) || SEC_PAT.test(cl)
  }

  // ── PRE-SCAN ─────────────────────────────────────────────────────────────
  let qPrefixHits = 0, numTitledHits = 0, capsTitleHits = 0, baseQHits = 0
  for (const l of lines) {
    const cl = l.replace(/~~/g, '').trim()
    if (Q_PREFIX.test(cl) || Q_PREFIX2.test(cl)) qPrefixHits++
    if (NUM_TITLED.test(cl)) numTitledHits++
    if (CAPS_TITLE.test(cl) || CAPS_TITLE2.test(cl)) capsTitleHits++
    if (BASE_Q.test(cl)) baseQHits++
  }
  const hasQPrefix = qPrefixHits >= 2, hasNumTitled = numTitledHits >= 2, hasCapsTitle = capsTitleHits >= 2

  // ── PARSE STATE ──────────────────────────────────────────────────────────
  const sections = []
  let curSec = { name: 'Main Survey', questions: [], routing: [] }
  let curQ = null, qCounter = 0, inProgInst = false
  let secLetter = ''      // current section letter: 'S', 'B', 'C', 'D' etc.
  let secQCounter = 0     // per-section question counter for CAPS_TITLE questions

  // Helper: derive section letter prefix from section name
  function getSectionPrefix(secName) {
    // "Screener and Profiling" → S
    if (/screener|profil/i.test(secName)) return 'S'
    // "Section A: ..." → A  /  "SECTION B: ..." → B
    const secMatch = secName.match(/section\s+([A-Za-z])/i)
    if (secMatch) return secMatch[1].toUpperCase()
    // "DALLAH HEALTH" or "Section 4" → D (4th section)
    const numMatch = secName.match(/section\s+(\d+)/i)
    if (numMatch) {
      const n = parseInt(numMatch[1])
      return String.fromCharCode(64 + n) // 1→A, 2→B, 3→C, 4→D
    }
    // Fallback: use first letter of section name
    const first = secName.replace(/[^A-Za-z]/g, '')[0]
    return first ? first.toUpperCase() : 'Q'
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (STRIKE_FULL.test(line)) continue
    const cleanLine = line.replace(/~~/g, '').trim()
    if (!cleanLine) continue

    // PROGRAM INSTRUCTION blocks
    if (PROG_INST.test(cleanLine)) { inProgInst = true; continue }
    if (inProgInst) {
      if (isQuestionLine(cleanLine)) { inProgInst = false }
      else {
        if (curQ) {
          if (/MULTI\s*-?\s*CODE/i.test(cleanLine)) curQ.multiSelect = true
          if (/SINGLE\s*CODE/i.test(cleanLine)) curQ.multiSelect = false
          if (/OPEN\s*-?\s*END/i.test(cleanLine)) curQ.detectedType = 'TE'
          // Capture routing: TERMINATE, CLOSE, PLEASE TERMINATE IF...
          if (/TERMINATE|CLOSE/i.test(cleanLine)) curQ.routing.push(cleanLine)
          // Capture display logic: SHOW ONLY TO..., SHOW IF..., DISPLAY IF...
          if (/SHOW\s+(?:ONLY\s+)?(?:TO|IF)|DISPLAY\s+(?:IF|ONLY)/i.test(cleanLine)) curQ.routing.push(cleanLine)
          // Capture conditional references: IF CODED..., IF OPTION..., IF SELECTED...
          if (/IF\s+(?:CODED|OPTION|SELECTED|ONLY\s+OPTION)/i.test(cleanLine)) curQ.routing.push(cleanLine)
          // Capture quota references
          if (/REFER\s+TO\s+(?:THE\s+)?QUOTA/i.test(cleanLine)) curQ.routing.push(cleanLine)
          // Capture ASK/PIPE instructions
          if (/ASK\s+(?:THE\s+)?(?:NUMERICAL|AS\s+NUMERICAL|AS\s+OE|ONLY\s+IF)/i.test(cleanLine)) curQ.routing.push(cleanLine)
          if (/AUTO[\s-]*PUNCH|PIPE\s+IN|CARRY\s+FORWARD|INCLUDE\s+THE/i.test(cleanLine)) curQ.routing.push(cleanLine)
          // Type detection from instructions
          if (/RANDOMIS?E|ROTATE/i.test(cleanLine)) curQ.randomize = true
          if (/GRID|MATRIX|BATTERY/i.test(cleanLine)) curQ.detectedType = 'Matrix'
          if (/SLIDER/i.test(cleanLine)) curQ.detectedType = 'Slider'
          if (/NPS|NET\s+PROMOTER/i.test(cleanLine)) curQ.detectedType = 'NPS'
          if (/RANK/i.test(cleanLine)) curQ.detectedType = 'RO'
          if (/CONSTANT\s+SUM/i.test(cleanLine)) curQ.detectedType = 'CS'
          if (/1-7\s+SCALE|7[- ]POINT|LIKERT/i.test(cleanLine)) curQ.detectedType = 'Slider'
          if (/NUMERICAL\s+OE|NUMERIC/i.test(cleanLine)) curQ.detectedType = 'TE'
          if (/GIVE\s+\w+\s+BOX/i.test(cleanLine)) curQ.detectedType = 'TE'
        }
        continue
      }
    }

    if (SKIP_PAT.test(cleanLine)) continue

    // Section headers
    const secM = SEC_PAT.exec(cleanLine)
    if (secM) {
      inProgInst = false
      if (curQ) { curSec.questions.push(curQ); curQ = null }
      if (curSec.questions.length || curSec.routing.length) sections.push(curSec)
      const secName = (secM[1] || secM[2] || secM[3] || cleanLine).trim()
      curSec = { name: secName, questions: [], routing: [] }
      // Extract section letter from the FULL line: "Section A: ..." → A, "SECTION B: ..." → B, "Section 4: ..." → D
      const letterMatch = cleanLine.match(/section\s+([A-Za-z])\s*[:\s\-–—]/i)
      const numSecMatch = cleanLine.match(/section\s+(\d+)\s*[:\s\-–—]/i)
      if (letterMatch) {
        secLetter = letterMatch[1].toUpperCase()
        // Special case: Section A with "Screener" → use S prefix (doc references S.3, S.4)
        if (secLetter === 'A' && /screener|profil/i.test(cleanLine)) secLetter = 'S'
      } else if (numSecMatch) {
        // Section 4 → D (map number to letter: 1→A, 2→B, 3→C, 4→D)
        secLetter = String.fromCharCode(64 + parseInt(numSecMatch[1]))
      } else if (/screener|profil/i.test(cleanLine)) {
        secLetter = 'S'
      } else {
        secLetter = secName.replace(/[^A-Za-z]/g, '')[0]?.toUpperCase() || 'Q'
      }
      secQCounter = 0
      continue
    }
    if (ASK_PAT.test(cleanLine)) continue

    // Routing
    if (RT_PAT.test(cleanLine)) {
      if (curQ) curQ.routing.push(cleanLine); else curSec.routing.push(cleanLine)
      continue
    }

    // ── Question detection ──
    let qId = null, qText = null, forcedType = null

    let m = Q_PREFIX.exec(cleanLine)
    if (m) { qId = m[1].toUpperCase(); qText = m[2] }
    if (!qId) { m = Q_PREFIX2.exec(cleanLine); if (m) { qId = 'Q'+m[1].toUpperCase(); qText = m[2] } }
    if (!qId) {
      m = Q_SOLO.exec(cleanLine)
      if (m && i+1 < lines.length) {
        const next = lines[i+1]?.replace(/~~/g,'').trim()
        if (next && next.length > 10 && !Q_PREFIX.test(next) && !Q_SOLO.test(next) && !SEC_PAT.test(next)) {
          qId = m[1].toUpperCase(); qText = next; i++
        }
      }
    }
    if (!qId) { m = BRACKET_Q.exec(cleanLine); if (m) { qId = m[1].toUpperCase(); if (!/^[QS]/i.test(qId)) qId='Q'+qId; qText = m[2] } }
    if (!qId) {
      m = PIPE_Q.exec(cleanLine)
      if (m) { qId = m[1].toUpperCase(); const p = cleanLine.split('|'); forcedType = p[1]||null; qText = p.slice(3).join('|')||p[2]||'' }
    }
    if (!qId && (hasNumTitled || !hasQPrefix)) {
      m = NUM_TITLED.exec(cleanLine)
      if (m && parseInt(m[1]) <= 100 && m[2].length > 2) {
        const rawNum = parseInt(m[1])
        const capsText = m[2].trim()
        // Guard: if we have a current question and this number <= current question number,
        // it's likely a numbered choice, not a new question
        const curQNum = curQ ? parseInt((curQ.id.match(/(\d+)/)||[])[1] || '0') : 0
        // Also guard: require at least 3 actual uppercase letters (not just "IT ")
        const uppercaseLetters = (capsText.match(/[A-Z]/g) || []).length
        if (rawNum > curQNum && uppercaseLetters >= 3) {
          const capsLabel = capsText.replace(/\s*\[.*$/, '').trim()
          const prefix = secLetter || 'Q'
          qId = prefix + '.' + rawNum
          // Look ahead for normal-case follow-up text (actual respondent question)
          let followUp = ''
          let peekIdx = i + 1
          while (peekIdx < lines.length) {
            const peekLine = lines[peekIdx]?.replace(/~~/g, '').trim()
            if (!peekLine) { peekIdx++; continue }
            const isNormalText = /^[A-Z][a-z]/.test(peekLine) || /^[a-z]/.test(peekLine) ||
                                 (/^[A-Z]/.test(peekLine) && /[a-z]/.test(peekLine.slice(1,20)))
            const isNotMeta = !NUM_TITLED.test(peekLine) && !CAPS_TITLE.test(peekLine) &&
                              !SEC_PAT.test(peekLine) && !PROG_INST.test(peekLine) &&
                              !SKIP_PAT.test(peekLine) && !ASK_PAT.test(peekLine) &&
                              !/^[-=_]{3,}$/.test(peekLine) && !/^\d{1,2}\s{2,}/.test(peekLine) &&
                              !/^\d{1,3}[.)]\s+[A-Z][a-z]/.test(peekLine)
            if (isNormalText && isNotMeta && peekLine.length > 15) {
              followUp = peekLine
              i = peekIdx
              while (i + 1 < lines.length) {
                const contLine = lines[i + 1]?.replace(/~~/g, '').trim()
                if (contLine && /^[a-z]/.test(contLine) && contLine.length > 5 && !NUM_CHOICE.test(contLine)) {
                  followUp += ' ' + contLine; i++
                } else break
              }
              break
            }
            break
          }
          qText = followUp || capsLabel
          inProgInst = false
        }
      }
    }
    if (!qId && (hasCapsTitle || !hasQPrefix)) {
      m = CAPS_TITLE.exec(cleanLine)
      if (!m) m = CAPS_TITLE2.exec(cleanLine)
      if (m) {
        secQCounter++
        const capsLabel = m[1].trim()
        const prefix = secLetter || 'Q'
        qId = prefix + '.' + secQCounter
        // Look ahead for normal-case follow-up text
        let followUp = ''
        let peekIdx = i + 1
        while (peekIdx < lines.length) {
          const peekLine = lines[peekIdx]?.replace(/~~/g, '').trim()
          if (!peekLine) { peekIdx++; continue }
          const isNormalText = /^[A-Z][a-z]/.test(peekLine) || /^[a-z]/.test(peekLine) ||
                               (/^[A-Z]/.test(peekLine) && /[a-z]/.test(peekLine.slice(1,20)))
          const isNotMeta = !NUM_TITLED.test(peekLine) && !CAPS_TITLE.test(peekLine) &&
                            !SEC_PAT.test(peekLine) && !PROG_INST.test(peekLine) &&
                            !SKIP_PAT.test(peekLine) && !ASK_PAT.test(peekLine) &&
                            !/^[-=_]{3,}$/.test(peekLine)
          if (isNormalText && isNotMeta && peekLine.length > 15) {
            followUp = peekLine
            i = peekIdx
            while (i + 1 < lines.length) {
              const contLine = lines[i + 1]?.replace(/~~/g, '').trim()
              if (contLine && /^[a-z]/.test(contLine) && contLine.length > 5 && !NUM_CHOICE.test(contLine)) {
                followUp += ' ' + contLine; i++
              } else break
            }
            break
          }
          break
        }
        qText = followUp || capsLabel
        inProgInst = false
      }
    }
    if (!qId && baseQHits >= 2) {
      m = BASE_Q.exec(cleanLine)
      if (m && m[1]) { qId = m[1].toUpperCase(); qText = m[2]||'' }
    }
    if (!qId && !hasQPrefix && !hasNumTitled && !hasCapsTitle) {
      m = NUM_LONG.exec(cleanLine)
      if (m && parseInt(m[1]) <= 100) {
        const t = m[2]
        if (t.length > 30 || /\?/.test(t) || /^(?:how|what|which|where|when|who|do |does |are |is |have |please |rate |to what|on a scale|thinking|would you)/i.test(t))
          { qId = 'Q'+m[1]; qText = t }
      }
    }

    if (qId && qText !== null) {
      inProgInst = false
      if (curQ) curSec.questions.push(curQ)

      // ── Extract audience/display logic from question title BEFORE cleaning ──
      const audienceRouting = []
      const audienceMatches = (qText + ' ' + cleanLine).matchAll(/\[(ONLY\s+(?:FOR\s+)?[\w\s&]+|SHOW\s+(?:ONLY\s+)?TO\s+[\w\s&]+|FOR\s+(?:ALL|[\w\s&]+)|(?:ALL\s+)?(?:DALLAH\s+)?[\w\s&]*RESPONDENTS?|PATIENTS?\s*(?:ONLY)?|HCPs?\s*(?:ONLY)?|PARTNERS?\s*(?:ONLY)?)\]/gi)
      for (const am of audienceMatches) {
        const tag = am[1].trim()
        if (!/^ALL\s*RESPONDENTS?$/i.test(tag) && !/^FOR\s+ALL$/i.test(tag)) {
          audienceRouting.push(`DISPLAY_IF: ${tag}`)
        }
      }

      const ct = qText.replace(/\*+/g,'')
        .replace(/\[SELECT ALL[^\]]*\]|\[EXCLUSIVE\]|\[SINGLE\s*CODE?\]|\[MULTI(?:PLE)?\s*CODE?\]|\[OPEN\s*END\]|\[NUMERIC\]|\[GRID\]|\[MATRIX\]|\[NPS\]|\[RANK[^\]]*\]|\[SLIDER\]|\[CONSTANT SUM\]|\[MAX\s*DIFF\]|\[FOR THE FW PARTNER\]/gi,'')
        .replace(/\[(?:ALL\s+)?RESPONDENTS?\]|\[ONLY\s+(?:FOR\s+)?[\w\s&]+\]|\[SHOW\s+(?:ONLY\s+)?TO\s+[\w\s&]+\]|\[FOR\s+(?:ALL|[\w\s&]+)\]|\[(?:PATIENTS?|HCPs?|PARTNERS?)\s*(?:ONLY)?\]|\[ALL\s+DALLAH[\w\s]*\]/gi,'')
        .replace(/\s*–\s*(?:OPEN END|For All|PATIENTS?|HCPs?|ALL)\s*$/i,'')
        .trim()
      const numM = qId.match(/\d+/)
      if (numM) qCounter = Math.max(qCounter, parseInt(numM[0]))
      curQ = {
        id: qId, text: ct, choices: [], routing: [...audienceRouting], matrixRows: [], matrixColumns: [],
        multiSelect: /SELECT ALL|MULTI\s*-?\s*CODE|MULTIPLE/i.test(qText+' '+cleanLine),
        isDescriptive: /thank you|descriptive text|end message|intro(?:duction)?\s+text|welcome|\[INSERT\s+TEXT\]|information\s+screen/i.test(ct),
        randomize: /RANDOMIS?E|ROTATE/i.test(cleanLine),
        detectedType: forcedType || detectQType(qText),
      }
      continue
    }

    // ── Choices ──
    if (!curQ) continue

    // Skip standalone numeric choice codes (01, 02, 1, 2) from mammoth table extraction
    // These are choice codes, not actual choice text — the next line has the real text
    if (/^\d{1,2}$/.test(cleanLine)) continue

    // Skip table separators (including mammoth-style with spaces between dash groups)
    if (/^[-=_]{3,}$/.test(cleanLine) || /^\+[-=+]+\+$/.test(cleanLine) || /^[|+][-=+|]+[|+]$/.test(cleanLine) ||
        /^[-=_\s]{5,}$/.test(cleanLine) && /[-=_]{3,}/.test(cleanLine)) continue

    const tM = TBL_CHOICE.exec(cleanLine)
    if (tM) {
      const ch = tM[2].replace(/\s{2,}.*$/,'').trim()
      if (ch && ch.length < 200) {
        curQ.choices.push(ch)
        if (/TERMINATE|CLOSE/i.test(cleanLine)) curQ.routing.push(`TERMINATE_IF_SELECTED: ${ch}`)
      }
      continue
    }
    const ccM = CODED_CHOICE.exec(cleanLine)
    if (ccM && ccM[2].trim().length > 0) {
      const ch = ccM[2].replace(/\s*\[?(?:TERMINATE|CLOSE)\]?\s*/gi,'').trim()
      if (ch) { curQ.choices.push(ch); if (/TERMINATE|CLOSE/i.test(cleanLine)) curQ.routing.push(`TERMINATE_IF_SELECTED: ${ch}`) }
      continue
    }
    const bM = BULLET.exec(cleanLine)
    if (bM) { const c = (bM[1]||bM[2]||'').replace(/\s*\[.*?\]\s*/g,'').trim(); if (c && c.length < 200) curQ.choices.push(c); continue }
    const nM = NUM_CHOICE.exec(cleanLine)
    if (nM) {
      const ch = nM[2].replace(/\s*\[?(?:TERMINATE|CLOSE)\]?\s*/gi,'').replace(/\s*\[.*?\]\s*/g,'').trim()
      if (ch) { curQ.choices.push(ch); if (/TERMINATE|CLOSE/i.test(nM[2])) curQ.routing.push(`TERMINATE_IF_SELECTED: ${ch}`) }
      continue
    }
    if (/^(?:CONTINUE|TERMINATE|CLOSE)\s*$/i.test(cleanLine)) {
      if (/TERMINATE|CLOSE/i.test(cleanLine) && curQ.choices.length > 0)
        curQ.routing.push(`TERMINATE_IF_SELECTED: ${curQ.choices[curQ.choices.length-1]}`)
      continue
    }
    if (/^[-=_]{3,}$/.test(cleanLine) || /^\+[-=+]+\+$/.test(cleanLine) || /^[|+][-=+|]+[|+]$/.test(cleanLine)) continue

    if (cleanLine.length < 140 && cleanLine.length > 1 &&
        !SEC_PAT.test(cleanLine) && !ASK_PAT.test(cleanLine) &&
        !CAPS_TITLE.test(cleanLine) && !NUM_TITLED.test(cleanLine) &&
        !/^(?:PROGRAM|CODING|SCRIPTER|DP\s+NOTE)\s/i.test(cleanLine)) {
      const c = cleanLine.replace(/\s*\[.*?\]\s*/g,'').replace(/\s{2,}(?:CONTINUE|TERMINATE|CLOSE|GO\s*TO|SKIP)\s*$/i,'').trim()
      if (c && c.length > 1) curQ.choices.push(c)
    }
  }

  if (curQ) curSec.questions.push(curQ)
  if (curSec.questions.length) sections.push(curSec)

  // Post-process: clean choices and detect types
  for (const sec of sections) {
    for (const q of sec.questions) {
      // Remove separator lines, standalone numbers, CONTINUE/TERMINATE markers, and junk from choices
      q.choices = (q.choices || []).filter(c => {
        if (typeof c !== 'string') return true
        const t = c.trim()
        if (!t || t.length < 2) return false
        // Remove table separator lines (dashes, equals, underscores with optional spaces)
        if (/^[-=_\s]{3,}$/.test(t) && /[-=_]{2,}/.test(t)) return false
        // Remove standalone numbers (choice codes)
        if (/^\d{1,2}$/.test(t)) return false
        // Remove standalone CONTINUE/TERMINATE
        if (/^(?:CONTINUE|TERMINATE|CLOSE)\s*$/i.test(t)) return false
        // Remove lines that are just table grid characters
        if (/^\+[-=+\s]+\+$/.test(t) || /^[|+][-=+|\s]+[|+]$/.test(t)) return false
        // Remove parenthetical fragments from mammoth table extraction
        if (/^\([^)]*\)\s*$/.test(t) && t.length < 15) return false
        return true
      })
      // Detect question type from content
      if (!q.detectedType) q.detectedType = detectQType(q.text + ' ' + q.choices.join(' '))
    }
  }
  // Filter out "Main Survey" default section if it only has junk from methodology text
  return sections.filter(sec => !(sec.name === 'Main Survey' && sec.questions.length <= 1))
}

// Convert parsed sections to survey structure
function sectionsToStructure(sections, surveyName) {
  const blocks     = []
  const surveyFlow = []
  let   qNum       = 1
  let   blNum      = 1

  // Collect all routing rules for AI to interpret
  const allRoutingRules = []

  for (const sec of sections) {
    const bid       = 'BL_' + String(blNum++).padStart(3,'0')
    const questions = []

    // Section-level routing rule
    if (sec.routing.length > 0) {
      allRoutingRules.push({ blockId: bid, blockName: sec.name, rules: sec.routing })
    }

    for (const q of sec.questions) {
      const qid  = 'QID' + qNum++
      // Use detected type from parser, or default based on flags
      let type = 'MC'
      if (q.isDescriptive) type = 'DB'
      else if (q.detectedType && q.detectedType !== 'MC') type = q.detectedType
      else if (q.multiSelect) type = 'MC'

      // Apply skipLogic directly from parsed routing
      const skipRules = []
      for (const rule of q.routing) {
        const clean = rule.replace(/^-\s+/, '').trim()
        const termMatch = clean.match(/TERMINATE_IF_SELECTED:\s*(.+)/i)
        if (termMatch) {
          const termText = termMatch[1].trim()
          const idx = q.choices.findIndex(c => {
            const ct = (typeof c === 'string' ? c : '').toLowerCase()
            const tt = termText.toLowerCase()
            return ct.includes(tt) || tt.includes(ct)
          })
          console.log(`  SKIP: ${q.id} → "${termText}" → choice idx=${idx} (choices: ${JSON.stringify(q.choices.slice(0,4))})`)
          if (idx >= 0) {
            skipRules.push({
              choiceIndex: idx + 1, choiceText: q.choices[idx],
              operator: 'Selected', destination: 'EndOfSurvey', destinationType: 'EndOfSurvey'
            })
          }
        }
      }
      if (skipRules.length > 0) console.log(`  → ${q.id}: ${skipRules.length} skip rules applied`)

      questions.push({
        id:            qid,
        type,
        questionText:  q.text,
        dataExportTag: q.id,
        required:      !q.isDescriptive,
        multiSelect:   q.multiSelect,
        longText:      type === 'TE',
        choices:       q.choices,
        matrixRows:    q.matrixRows || [],
        matrixColumns: q.matrixColumns || [],
        displayLogic:  { conditions: [] },
        skipLogic:     { rules: skipRules },
        _srcRouting:   q.routing  // temp field for display logic in Step 1.5
      })

      if (q.routing.length > 0) {
        allRoutingRules.push({ qid, qSrcId: q.id, rules: q.routing })
      }
    }

    blocks.push({
      id:          bid,
      description: sec.name,
      type:        'Standard',
      includeIf:   [],
      questions
    })

    surveyFlow.push({ type: 'Block', id: bid, description: sec.name })

    // Add Branch→EndSurvey for terminate conditions in this block
    for (const q of questions) {
      if (q.skipLogic?.rules?.length > 0 && q.choices?.length > 0 && q.type !== 'TE' && q.type !== 'DB') {
        for (const rule of q.skipLogic.rules) {
          if (rule.destination === 'EndOfSurvey' && rule.choiceIndex > 0 && rule.choiceIndex <= q.choices.length) {
            surveyFlow.push({
              type: 'Branch',
              condition: {
                questionId: q.id,
                questionTag: q.dataExportTag,
                questionText: q.questionText?.slice(0, 60),
                choiceText: rule.choiceText,
                choiceIndex: rule.choiceIndex,
                operator: 'Selected'
              },
              flow: [{ type: 'EndSurvey' }]
            })
          }
        }
      }
    }
  }

  surveyFlow.push({ type: 'EndSurvey' })

  return { structure: { surveyName, blocks, surveyFlow }, routingRules: allRoutingRules }
}

// ── Routes ────────────────────────────────────────────────────────────────

// Root — helpful message if someone opens :3001 in browser
app.get('/', (_, res) => res.send(`
  <h2>Tusk.AI Backend — Local Dev</h2>
  <p>API is running ✅</p>
  <p>Open the frontend at <a href="http://localhost:5173">http://localhost:5173</a></p>
  <ul>
    <li>GET <a href="/api/health">/api/health</a></li>
  </ul>
`))

// Parse uploaded file → extract text
app.post('/api/surveys/parse-file', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const filename    = req.headers['x-filename'] || 'upload.txt'
    const buffer      = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)
    const { text, pages, method, warning } = await extractTextFromFile(buffer, filename)
    res.json({ text, pages, method, warning, chars: text.length })
  } catch(e) {
    console.error('❌ Route error:', e.message, '\nStack:', e.stack?.split('\n')[1]?.trim())
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n').slice(0,3).join(' | ') })
  }
})

// Health check
app.get('/api/health', (_, res) => res.json({
  ok: true, mode: 'local-dev',
  apiKeySet: !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'PASTE_YOUR_KEY_HERE'),
  ts: new Date()
}))

// Auth
app.post('/api/auth/sync', (req, res) => {
  const { uid, email, name, photo } = req.body
  if (!uid) return res.status(400).json({ error: 'No uid in body' })
  if (!users.has(uid)) {
    users.set(uid, { id: users.size + 1, uid, email: email||'', name: name||'', photo: photo||null, plan: 'premium' })
  } else {
    // Update name/email if provided
    const u = users.get(uid)
    if (email) u.email = email
    if (name)  u.name  = name
  }
  res.json({ user: users.get(uid) })
})

app.get('/api/auth/me', (req, res) => {
  res.json({ user: getUser(req) })
})

// Extract logic (Pass 1)
app.post('/api/surveys/extract-logic', async (req, res) => {
  const { fileText, fileName, apiKey } = req.body
  if (!fileText) return res.status(400).json({ error: 'No file text provided' })

  // Compress text to reduce tokens
  const compressed = compressQuestionnaire(fileText, 10000)
  const tokens     = estimateTokens(compressed)
  console.log(`Extract-logic: ~${tokens} tokens from ${compressed.length} chars`)

  const system = `You are a survey routing logic analyst. Extract routing rules as compact JSON. Return ONLY valid JSON — no markdown.`

  const prompt = `Extract ALL routing/skip/display logic from this questionnaire.

File: ${fileName || 'questionnaire'}
---
${compressed}
---

Return ONLY this compact JSON (no markdown, no extra fields):
{"qidMap":{"Q1":"QID1"},"rules":[{"ruleId":"R1","type":"DisplayLogic","sourceQuestion":"Q2","condition":{"operator":"Selected","choiceText":"Yes","choiceIndex":1},"action":{"type":"ShowQuestion","targetQuestion":"Q5"},"verbatimInstruction":"IF Q2=Yes SHOW Q5","confidence":"High","notes":""}],"sections":[{"name":"Section 2","showCondition":"Q1=Yes","blockRoute":true,"includeIf":[{"questionId":"QID1","choiceIndex":1,"choiceText":"Yes","operator":"Selected"}]}],"carryForward":[],"globalRules":[],"ambiguities":[]}`

  try {
    const raw = await callClaude(apiKey, system, prompt, 3000, 'claude-haiku-4-5-20251001')
    let logicMap
    try {
      let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const start = clean.indexOf('{')
      const end   = clean.lastIndexOf('}')
      logicMap = JSON.parse(clean.slice(start, end + 1))
    } catch {
      logicMap = { qidMap: {}, rules: [], sections: [], ambiguities: [] }
    }

    // Pass 2: verify extracted rules against source text
    try {
      logicMap = verifyLogicRules(logicMap, fileText)
    } catch(ve) {
      console.warn('verifyLogicRules failed (non-critical):', ve.message)
    }

    // Pass 3: Deterministic routing extraction from parser
    // This catches routing that the AI misses (audience tags, PROGRAM INSTRUCTION blocks, etc.)
    try {
      const fmt = detectFormat(fileText)
      const parsedSections = fmt === 'structured-spec' ? parseStructuredSpec(fileText) : parseQuestionnaire(fileText)
      let detRuleId = (logicMap.rules?.length || 0) + 1

      for (const sec of parsedSections) {
        for (const q of sec.questions) {
          if (!q.routing || q.routing.length === 0) continue
          for (const routeText of q.routing) {
            const clean = routeText.replace(/^-\s+/, '').trim()
            if (!clean || clean.length < 5) continue

            // Determine rule type and action
            let type = 'DisplayLogic', actionType = 'ShowQuestion'
            if (/TERMINATE|CLOSE/i.test(clean)) { type = 'SkipLogic'; actionType = 'TerminateSurvey' }
            else if (/DISPLAY_IF/i.test(clean)) { type = 'DisplayLogic'; actionType = 'ShowQuestion' }
            else if (/SHOW\s+(?:ONLY|IF|TO)/i.test(clean)) { type = 'DisplayLogic'; actionType = 'ShowQuestion' }
            else if (/SKIP|GO\s*TO|GOTO/i.test(clean)) { type = 'SkipLogic'; actionType = 'SkipToQuestion' }
            else if (/REFER.*QUOTA/i.test(clean)) { type = 'QuotaCheck'; actionType = 'CheckQuota' }
            else if (/PIPE|CARRY|INCLUDE|AUTO/i.test(clean)) { type = 'Piping'; actionType = 'PipeResponse' }
            else continue // skip non-routing instructions

            // Check if this rule already exists in AI-extracted rules (avoid duplicates)
            const isDuplicate = logicMap.rules?.some(r =>
              r.sourceQuestion === q.id && r.verbatimInstruction?.toLowerCase().includes(clean.toLowerCase().slice(0, 30))
            )
            if (isDuplicate) continue

            logicMap.rules = logicMap.rules || []
            logicMap.rules.push({
              ruleId: 'D' + detRuleId++,
              type,
              sourceQuestion: q.id,
              sourceQID: null,
              condition: {
                operator: /DISPLAY_IF/i.test(clean) ? 'ShowIf' : /TERMINATE/i.test(clean) ? 'Selected' : /SHOW/i.test(clean) ? 'ShowIf' : 'Condition',
                choiceText: clean.replace(/^DISPLAY_IF:\s*/i, '').replace(/^TERMINATE_IF_SELECTED:\s*/i, '').replace(/^-\s+/,'').slice(0, 80),
                choiceIndex: null
              },
              action: { type: actionType, targetQuestion: null },
              verbatimInstruction: clean,
              confidence: 'High',
              notes: ''
            })
          }
        }
      }
      console.log(`Deterministic extraction added ${detRuleId - (logicMap.rules?.length || 0) - 1} rules`)
    } catch(de) {
      console.warn('Deterministic extraction failed (non-critical):', de.message)
    }

    console.log(`Extract-logic result: ${logicMap.rules?.length || 0} rules, ${logicMap.sections?.length || 0} sections`)
    if (logicMap.rules?.length > 0) {
      logicMap.rules.forEach(r => console.log(`  Rule: ${r.sourceQuestion} ${r.condition?.choiceText} → ${r.action?.type} [${r.confidence}]`))
    }
    res.json({ logicMap })
  } catch (e) {
    console.error('❌ Route error:', e.message, '\nStack:', e.stack?.split('\n')[1]?.trim())
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n').slice(0,3).join(' | ') })
  }
})

// Build survey (Pass 2)
app.post('/api/surveys/build', async (req, res) => {
  const { fileText, prompt: userPrompt, logicMap, brandId } = req.body
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY

  // DIAGNOSTIC
  console.log('\n=== BUILD REQUEST ===')
  console.log('fileText:', fileText ? `${fileText.length} chars` : 'MISSING')
  console.log('logicMap rules:', logicMap?.rules?.length || 0)

  if (!fileText || fileText.length < 10)
    return res.status(400).json({ error: 'fileText is empty — re-upload your questionnaire' })

  // ── STEP 1: Parse questionnaire deterministically ─────────────────────────
  // Sanity check: does the text look readable?
  const printable = fileText.split('').filter(c => { const cc = c.charCodeAt(0); return (cc >= 32 && cc < 127) || cc === 10 || cc === 13 }).length
  const printableRatio = printable / Math.max(fileText.length, 1)
  console.log(`fileText printable ratio: ${Math.round(printableRatio*100)}%`)

  if (printableRatio < 0.7) {
    return res.status(422).json({
      error: 'File content appears to be binary — mammoth may not be installed. Run: npm install in the backend folder, then restart.'
    })
  }

  const surveyName = userPrompt?.slice(0,60) || 'Generated Survey'
  const fmt          = detectFormat(fileText)
  console.log('Detected format:', fmt)
  const sections     = fmt === 'structured-spec' ? parseStructuredSpec(fileText) : parseQuestionnaire(fileText)
  const embeddedData = parseEmbeddedData(fileText)
  const flowOutline  = parseFlowOutline(fileText)
  if (embeddedData.length > 0) console.log(`Embedded data fields: ${embeddedData.length} (${embeddedData.slice(0,3).map(f=>f.name).join(', ')}...)`)
  if (flowOutline)              console.log(`Flow outline: ${flowOutline.length} items (${flowOutline.filter(f=>f.type==='Branch').length} branches)`)
  let { structure, routingRules } = sectionsToStructure(sections, surveyName)

  const totalQ = structure.blocks.reduce((n,b) => n+(b.questions?.length||0), 0)
  console.log(`Parsed: ${structure.blocks.length} blocks, ${totalQ} questions, ${routingRules.length} routing rules`)
  structure.blocks.forEach(b =>
    console.log(`  "${b.description}": ${b.questions.length} questions`)
  )

  if (totalQ === 0) {
    console.log('First 200 chars of fileText:', JSON.stringify(fileText.slice(0,200)))
    return res.status(422).json({
      error: 'No questions found in questionnaire',
      hint: 'Ensure file has questions like "Q1. ..." or "S1. ..." and sections like "SECTION 1: ..."',
      preview: fileText.slice(0, 200)
    })
  }

  // ── STEP 1.5: Deterministic routing application ────────────────────────
  // Apply routing rules from the parser directly to displayLogic/skipLogic
  // MUST run before AI routing (Step 2) because AI may overwrite structure
  try {
    const tagToQid = {}
    structure.blocks.forEach(b => b.questions?.forEach(q => {
      if (q.dataExportTag) tagToQid[q.dataExportTag] = q.id
      const noDot = q.dataExportTag.replace('.', '')
      if (noDot !== q.dataExportTag) tagToQid[noDot] = q.id
    }))

    const respTypeQid = tagToQid['S.1'] || tagToQid['S1'] || tagToQid['A.1'] || null

    const audienceToChoice = {
      'patients': { text: 'Patient', index: 1 },
      'patient': { text: 'Patient', index: 1 },
      'only for patients': { text: 'Patient', index: 1 },
      'show to patients': { text: 'Patient', index: 1 },
      'show only to patients': { text: 'Patient', index: 1 },
      'hcps': { text: 'Healthcare Professional (HCP)', index: 2 },
      'hcp': { text: 'Healthcare Professional (HCP)', index: 2 },
      'only for hcps': { text: 'Healthcare Professional (HCP)', index: 2 },
      'show only to hcps': { text: 'Healthcare Professional (HCP)', index: 2 },
      'show to hcps': { text: 'Healthcare Professional (HCP)', index: 2 },
      'partners': { text: 'Partner', index: 3 },
      'partner': { text: 'Partner', index: 3 },
      'only for partners': { text: 'Partner', index: 3 },
    }

    let appliedCount = 0
    for (const block of structure.blocks) {
      for (const q of block.questions) {
        const routing = q._srcRouting || []
        for (const rule of routing) {
          const clean = rule.replace(/^-\s+/, '').trim()

          const audienceMatch = clean.match(/(?:DISPLAY_IF:\s*|SHOW\s+(?:ONLY\s+)?TO\s+)(.+)/i) ||
                                clean.match(/(?:ONLY\s+(?:FOR|TO)\s+)(.+)/i)
          if (audienceMatch && respTypeQid) {
            const audience = audienceMatch[1].trim().toLowerCase()
              .replace(/\s*who\s+selected.*$/i, '').replace(/\s*\(.*$/i, '').trim()
            const mapping = audienceToChoice[audience]
            if (mapping) {
              q.displayLogic = q.displayLogic || { conditions: [] }
              const exists = q.displayLogic.conditions.some(c => c.questionId === respTypeQid && c.choiceIndex === mapping.index)
              if (!exists) {
                q.displayLogic.conditions.push({
                  questionId: respTypeQid, choiceIndex: mapping.index,
                  choiceText: mapping.text, operator: 'Selected', connector: 'And'
                })
                appliedCount++
              }
            }
          }

          // Skip logic (terminates) already applied in sectionsToStructure
        }
      }
    }
    console.log(`Deterministic routing applied: ${appliedCount} logic conditions`)
  } catch(routeErr) {
    console.warn('Deterministic routing apply failed:', routeErr.message)
  }

  // Clean _srcRouting temp fields
  structure.blocks.forEach(b => b.questions?.forEach(q => delete q._srcRouting))

  // ── STEP 2: AI routing disabled — deterministic routing from Step 1.5 is sufficient ──
  const allRules = [
    ...(logicMap?.rules    || []),
    ...(logicMap?.sections || []).map(s => ({ verbatimInstruction: `BLOCK "${s.name}": show only if ${s.showCondition}`, action: { type: 'ShowBlock', targetBlock: s.name }, ...s }))
  ]

  // Combine parsed routing + logicMap routing into one spec
  const routingSpec = [
    ...routingRules.map(r => r.rules.join(' | ')),
    ...allRules.map(r => r.verbatimInstruction || `${r.sourceQuestion} ${r.condition?.choiceText} → ${r.action?.type}`)
  ].filter(Boolean)

  // Build QID lookup for AI
  const qidLookup = {}
  structure.blocks.forEach(b => b.questions.forEach(q => { qidLookup[q.dataExportTag] = q.id }))
  const qidLookupStr = Object.entries(qidLookup).map(([tag,qid]) => `${tag}=${qid}`).join(', ')

  if (routingSpec.length > 0) {
    console.log(`${routingSpec.length} routing rules available (applied deterministically in Step 1.5, skipping AI routing)`)
  }

  // Clean _srcRouting temp fields
  structure.blocks.forEach(b => b.questions?.forEach(q => delete q._srcRouting))

  // ── STEP 3: Normalize + validate + build QSF ─────────────────────────────
  // Apply SHOW IF display logic (deterministic — no AI needed)
  try { structure = applyShowIfToStructure(structure) } catch(e) { console.warn('applyShowIf:', e.message) }

  // Apply FLOW OUTLINE — replaces simple block-list surveyFlow with proper branches
  if (flowOutline && flowOutline.length > 0) {
    try {
      // Build block name → id map
      const blockDescMap = {}
      structure.blocks.forEach(b => { blockDescMap[b.description] = b.id })

      // Build tag → QID lookup
      const qidLookup = {}
      structure.blocks.forEach(b => b.questions?.forEach(q => {
        if (q.dataExportTag) qidLookup[q.dataExportTag] = q.id
      }))

      const builtFlow = flowOutlineToSurveyFlow(flowOutline, blockDescMap, qidLookup)
      if (builtFlow.length > 0) {
        // Ensure EndSurvey at end
        const lastItem = builtFlow[builtFlow.length - 1]
        if (lastItem?.type !== 'EndSurvey') builtFlow.push({ type: 'EndSurvey' })

        structure.surveyFlow = builtFlow
        const branches  = builtFlow.filter(f => f.type === 'Branch').length
        const blockRefs = builtFlow.filter(f => f.type === 'Block').length
        console.log(`Flow applied: ${blockRefs} blocks, ${branches} branches (terminate conditions)`)
      }
    } catch(fe) { console.warn('flowOutline apply failed:', fe.message) }
  }

  try { structure = normalizeQIDs(structure) } catch(e) {}
  try { structure = validateGrounding(structure, fileText) } catch(e) {}

  // Inject embedded data into surveyFlow (must be first element)
  if (embeddedData.length > 0) {
    structure.embeddedData = embeddedData
    // Add to front of surveyFlow
    structure.surveyFlow = [
      { type: 'EmbeddedData', embeddedData },
      ...structure.surveyFlow.filter(f => f.type !== 'EmbeddedData')
    ]
  }
  const qsf = buildQSF(structure, { brandId: brandId || 'qualtricsxm52yzcwcsx' })
  const id  = surveys.length + 1
  surveys.push({ id, name: structure.surveyName, structure, status:'draft', created_at: new Date() })
  res.json({ structure, surveyId: id, qsf })
})

app.post('/api/surveys/critique', async (req, res) => {
  const { fileText, apiKey } = req.body
  const system = `You are a senior market research methodologist. Return structured JSON critique only.`
  const prompt = `Critique this questionnaire for MR quality:\n\n${(fileText||'').slice(0,8000)}\n\nReturn ONLY JSON:\n{"overallScore":72,"overallGrade":"B","summary":"Executive summary","estimatedLOI":12,"issues":[{"severity":"Major","category":"Question Quality","question":"Q3","issue":"desc","recommendation":"fix","example":"rewrite"}],"strengths":["strength"],"missingElements":["missing"]}`
  try {
    const raw  = await callClaude(apiKey, system, prompt, 4096)
    const clean = raw.replace(/```json|```/g, '').trim()
    let critique
    try { critique = JSON.parse(clean) } catch { critique = { overallScore: 0, issues: [], summary: 'Parse error' } }
    res.json({ critique })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Debrief
app.post('/api/surveys/debrief', async (req, res) => {
  const { structure } = req.body
  if (!structure?.blocks) return res.status(400).json({ error: 'No structure provided' })

  const lines = []
  const now   = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
  lines.push(`# SURVEY PROGRAMMING SPECIFICATION\n**Survey:** ${structure.surveyName || 'Survey'}  \n**Date:** ${now}  \n**Generated by:** Tusk.AI — qualtrics.tuskresearch.ai\n\n---\n`)

  let qNum = 0
  for (const block of structure.blocks) {
    lines.push(`## ${block.description || 'Block'}`)
    if (block.includeIf?.length) {
      const cond = block.includeIf.map(c => `${c.questionId} ${c.operator} "${c.choiceText}"`).join(' OR ')
      lines.push(`> **Show only if:** ${cond}\n`)
    }
    for (const q of (block.questions || [])) {
      qNum++
      const label = q.dataExportTag || ('Q' + qNum)
      const typeMap = { MC:'Multiple Choice', TE:'Open End', Matrix:'Grid/Battery', NPS:'NPS', DB:'Descriptive', Slider:'Slider' }
      lines.push(`### ${label}. ${q.questionText}`)
      lines.push(`**Type:** ${typeMap[q.type]||q.type}${q.multiSelect?' (Multi)':''} | **Required:** ${q.required?'Yes':'No'}`)
      if (q.choices?.length) lines.push(`**Choices:** ${q.choices.map((c,i)=>`${i+1}. ${typeof c==='string'?c:c.text||c}`).join(' | ')}`)
      if (q.skipLogic?.rules?.length) lines.push(`**Routing:** ${q.skipLogic.rules.map(r=>`IF "${r.choiceText}" → ${r.destination}`).join('; ')}`)
      lines.push('')
    }
    lines.push('---\n')
  }
  res.json({ markdown: lines.join('\n'), surveyName: structure.surveyName })
})

// Build QSF from structure — uses battle-tested generator from Chrome extension
app.post('/api/surveys/build-qsf', (req, res) => {
  const { structure, brandId, ownerId } = req.body
  if (!structure) return res.status(400).json({ error: 'No structure provided' })
  try {
    const qsf = buildQSF(structure, { brandId: brandId || '', ownerId: ownerId || '' })
    res.json({ qsf, surveyId: qsf.SurveyEntry.SurveyID })
  } catch(e) {
    console.error('❌ Route error:', e.message, '\nStack:', e.stack?.split('\n')[1]?.trim())
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n').slice(0,3).join(' | ') })
  }
})

// Push to Qualtrics API
app.post('/api/surveys/push', async (req, res) => {
  const { structure, brandId, qApiToken, qDataCenter } = req.body
  if (!qApiToken) return res.status(400).json({ error: 'No Qualtrics API token' })
  if (!structure) return res.status(400).json({ error: 'No structure' })

  try {
    // First build the QSF
    const qsfReq = { body: { structure, brandId } }
    // Build inline
    const surveyId = 'SV_' + Math.random().toString(36).slice(2,18).toUpperCase()
    
    // Push via Qualtrics API v3
    const dc = qDataCenter || 'iad1'
    const baseUrl = `https://${dc}.qualtrics.com/API/v3`
    
    const { data: created } = await axios.post(`${baseUrl}/surveys`, {
      SurveyName: structure.surveyName || 'Survey',
      Language: 'EN',
      ProjectCategory: 'CORE'
    }, {
      headers: { 'X-API-TOKEN': qApiToken, 'Content-Type': 'application/json' }
    })

    const newSurveyId = created.result?.SurveyID || created.result?.id
    if (!newSurveyId) return res.status(500).json({ error: 'Failed to create survey in Qualtrics', detail: created })

    res.json({ surveyId: newSurveyId, message: `Survey created: ${newSurveyId}` })
  } catch(e) {
    const detail = e.response?.data || e.message
    res.status(500).json({ error: 'Qualtrics API error', detail })
  }
})

// Surveys list

// Billing stubs
app.post('/api/billing/checkout', (_, res) => res.json({ url: 'http://localhost:5173/pricing' }))
app.post('/api/billing/portal',   (_, res) => res.json({ url: 'http://localhost:5173/pricing' }))

// Admin stubs
app.get('/api/admin/stats', (_, res) => res.json({ users: [], surveys: [], usage: [] }))
app.get('/api/admin/users', (_, res) => res.json({ users: [...users.values()] }))

// Catch-all — helpful error instead of "Cannot GET"
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}`, tip: 'Open the app at http://localhost:5173' })
})

// Global error handler — catches any unhandled errors
app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err.message)
  console.error(err.stack)
  res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,4).join(' | ') })
})

// Handle unhandled rejections so process doesn't crash → ECONNRESET
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled rejection:', reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err.message)
})

app.listen(PORT, () => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const keyOk  = apiKey && apiKey !== 'PASTE_YOUR_KEY_HERE'
  console.log(`\n${'='.repeat(55)}`)
  console.log(`  🚀  Tusk.AI LOCAL DEV SERVER`)
  console.log(`${'='.repeat(55)}`)
  console.log(`  Backend  → http://localhost:${PORT}`)
  console.log(`  Frontend → http://localhost:5173`)
  console.log(`  API key  → ${keyOk ? '✅ set' : '⚠️  NOT SET — add ANTHROPIC_API_KEY to backend/.env'}`)
  console.log(`  CORS     → all localhost origins allowed`)
  console.log(`  Plan     → everyone is PREMIUM`)
  console.log(`${'='.repeat(55)}\n`)
  console.log(`  If frontend shows Network Error:`)
  console.log(`  1. Check this server is running (you should see this message)`)
  console.log(`  2. Check frontend .env.local has VITE_API_URL=/api`)
  console.log(`  3. Restart frontend with: npm run dev\n`)
})

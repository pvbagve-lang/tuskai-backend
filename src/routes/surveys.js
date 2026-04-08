// src/routes/surveys.js — Production survey routes with deterministic parser
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { attachDBUser } from '../middleware/user.js'
import { requirePlan } from '../middleware/auth.js'
import { pool } from '../db/schema.js'
import axios from 'axios'
import {
  detectFormat, parseQuestionnaire, parseStructuredSpec,
  sectionsToStructure, parseEmbeddedData, parseFlowOutline,
  flowOutlineToSurveyFlow, applyShowIfToStructure,
  validateGrounding, normalizeQIDs, extractTextFromFile,
  compressQuestionnaire, estimateTokens, verifyLogicRules
} from '../services/parser.js'
import { buildQSF } from '../services/qsf-generator.js'

const router = Router()
router.use(requireAuth, attachDBUser)

const CLAUDE = 'https://api.anthropic.com/v1/messages'

async function callClaude(apiKey, system, userMsg, maxTokens = 4000, model = 'claude-haiku-4-5-20251001') {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No API key')
  const { data } = await axios.post(CLAUDE, {
    model, max_tokens: maxTokens,
    system, messages: [{ role: 'user', content: userMsg }]
  }, {
    headers: { 'Content-Type':'application/json', 'x-api-key': key, 'anthropic-version':'2023-06-01' },
    timeout: 120000
  })
  const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
  return { text: data.content?.[0]?.text || '', tokens }
}

// ── Credit check middleware ──────────────────────────────────────────────
function requireCredits(req, res, next) {
  const user = req.dbUser
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  const remaining = (user.credits || 0) - (user.credits_used || 0)
  if (remaining <= 0) {
    return res.status(403).json({
      error: 'no_credits',
      message: 'No credits remaining. Contact admin for more credits.',
      creditsUsed: user.credits_used,
      creditsTotal: user.credits,
    })
  }
  next()
}

// ── PARSE FILE (extract text from DOCX/PDF) ─────────────────────────────
router.post('/parse-file', async (req, res) => {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body)
    const filename = req.headers['x-filename'] || 'upload.docx'
    const result = await extractTextFromFile(buffer, filename)
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── PASS 1: Extract logic (uses 0 credits) ──────────────────────────────
router.post('/extract-logic', async (req, res) => {
  const { fileText, fileName } = req.body
  if (!fileText) return res.status(400).json({ error: 'No file text provided' })
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY

  // Smart compression: keep routing-relevant lines, trim metadata
  const lines = fileText.split('\n')
  const important = []
  const contextLines = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    const isRouting = /TERMINATE|SHOW IF|DISPLAY_IF|ONLY FOR|SKIP|branch|end_survey|selected\(|not_selected|displayed\(|PROGRAM INST/i.test(l)
    const isQuestion = /^Q[:\s]|^\d+\.\s|^[A-Z]\.\d|MULTIPLE CHOICE|TEXT ENTRY|MATRIX|SAVR|MAVR|^id:\s/i.test(l)
    const isSection = /^(?:Demographics|Introduction|Screener|Block|Section|FLOW|flow:)/i.test(l)
    if (isRouting || isQuestion || isSection) {
      important.push(l)
    } else if (important.length < 400) {
      contextLines.push(l)
    }
  }
  // Build compressed text: all important lines + enough context
  let compressedText = important.join('\n')
  if (compressedText.length < 20000) {
    compressedText = fileText.slice(0, 25000) // Use more raw text if routing lines are sparse
  }

  const system = `You are a survey routing logic analyst for market research questionnaires. Extract every routing instruction. Look for: TERMINATE markers, SHOW IF conditions, DISPLAY_IF, "ONLY FOR [audience]", PROGRAM INSTRUCTIONS with skip/terminate, branch→end_survey in flow outlines, and question-level routing. Return ONLY valid JSON — no markdown, no backticks, no explanation before or after the JSON.`
  const prompt = `Extract ALL routing logic from this questionnaire.

Return this JSON structure:
{
  "qidMap": { "Q1": "QID1", "S.1": "QID1" },
  "rules": [
    {
      "ruleId": "R1",
      "type": "DisplayLogic",
      "sourceQuestion": "S.1",
      "sourceQID": "QID1",
      "condition": { "operator": "Selected", "choiceText": "Patient", "choiceIndex": 1 },
      "action": { "type": "ShowQuestion", "targetQuestion": "S.3", "targetQID": "QID3" },
      "verbatimInstruction": "ONLY FOR PATIENTS",
      "confidence": "High",
      "notes": ""
    },
    {
      "ruleId": "R2",
      "type": "EndSurvey",
      "sourceQuestion": "S.3",
      "sourceQID": "QID3",
      "condition": { "operator": "Selected", "choiceText": "No", "choiceIndex": 2 },
      "action": { "type": "EndSurvey" },
      "verbatimInstruction": "TERMINATE IF CODED 02 IN S.3",
      "confidence": "High",
      "notes": ""
    }
  ],
  "sections": [],
  "ambiguities": []
}

Types: DisplayLogic (show question if condition), SkipLogic (skip to question), EndSurvey (terminate), BranchLogic (conditional block).
Operators: Selected, NotSelected, Displayed, EqualTo, GreaterThan.

File: ${fileName}
---
${compressedText.slice(0, 25000)}`

  try {
    const { text: raw, tokens } = await callClaude(apiKey, system, prompt, 8192)
    // Clean response: strip markdown fences, find JSON object
    let clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    // Try to extract JSON object if there's text before/after it
    const jsonStart = clean.indexOf('{')
    const jsonEnd = clean.lastIndexOf('}')
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      clean = clean.slice(jsonStart, jsonEnd + 1)
    }
    let logicMap
    let parseError = null
    try { logicMap = JSON.parse(clean) }
    catch(pe) {
      parseError = pe.message
      logicMap = { qidMap:{}, rules:[], sections:[], ambiguities:[] }
    }

    // Log usage (no credit consumed for extraction)
    if (req.dbUser?.id) {
      await pool.query('INSERT INTO usage_log (user_id, action, tokens, meta) VALUES ($1,$2,$3,$4)',
        [req.dbUser.id, 'extract_logic', tokens, JSON.stringify({ fileName, rulesFound: logicMap?.rules?.length || 0, parseError })]).catch(()=>{})
      await pool.query('UPDATE users SET tokens_used = tokens_used + $1 WHERE id = $2', [tokens, req.dbUser.id]).catch(()=>{})
    }

    res.json({
      logicMap,
      aiStats: { model: 'claude-haiku-4-5-20251001', tokens, rulesExtracted: logicMap?.rules?.length || 0, connected: true, parseError }
    })
  } catch(e) {
    // API call itself failed — return empty but with error info
    res.json({
      logicMap: { qidMap:{}, rules:[], sections:[], ambiguities:[] },
      aiStats: { model: 'claude-haiku-4-5-20251001', tokens: 0, rulesExtracted: 0, connected: false, error: e.message }
    })
  }
})

// ── PASS 2: Build survey (CONSUMES 1 CREDIT) ────────────────────────────
router.post('/build', requireCredits, async (req, res) => {
  const { fileText, prompt: userPrompt, logicMap, brandId } = req.body
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY
  const surveyName = userPrompt || 'Generated Survey'

  if (!fileText || fileText.length < 10)
    return res.status(400).json({ error: 'fileText is empty' })

  try {
    // ── STEP 1: Deterministic parse ──
    const fmt = detectFormat(fileText)
    const sections = fmt === 'structured-spec' ? parseStructuredSpec(fileText) : parseQuestionnaire(fileText)
    const embeddedData = parseEmbeddedData(fileText)
    const flowOutline = parseFlowOutline(fileText)
    let { structure, routingRules } = sectionsToStructure(sections, surveyName)

    const totalQ = structure.blocks.reduce((n,b) => n+(b.questions?.length||0), 0)
    if (totalQ === 0) return res.status(422).json({ error: 'No questions found in questionnaire' })

    // ── STEP 1.5: Deterministic routing ──
    const tagToQid = {}
    structure.blocks.forEach(b => b.questions?.forEach(q => {
      if (q.dataExportTag) tagToQid[q.dataExportTag] = q.id
      const noDot = q.dataExportTag.replace('.', '')
      if (noDot !== q.dataExportTag) tagToQid[noDot] = q.id
    }))
    const respTypeQid = tagToQid['S.1'] || tagToQid['S1'] || tagToQid['A.1'] || null
    const audienceToChoice = {
      'patients':{ text:'Patient', index:1 }, 'patient':{ text:'Patient', index:1 },
      'only for patients':{ text:'Patient', index:1 }, 'show to patients':{ text:'Patient', index:1 },
      'show only to patients':{ text:'Patient', index:1 },
      'hcps':{ text:'Healthcare Professional (HCP)', index:2 }, 'hcp':{ text:'Healthcare Professional (HCP)', index:2 },
      'only for hcps':{ text:'Healthcare Professional (HCP)', index:2 },
      'show only to hcps':{ text:'Healthcare Professional (HCP)', index:2 },
      'show to hcps':{ text:'Healthcare Professional (HCP)', index:2 },
      'partners':{ text:'Partner', index:3 }, 'partner':{ text:'Partner', index:3 },
      'only for partners':{ text:'Partner', index:3 },
    }

    let appliedCount = 0
    for (const block of structure.blocks) {
      for (const q of block.questions) {
        const routing = q._srcRouting || []
        for (const rule of routing) {
          const clean = rule.replace(/^-\s+/, '').trim()
          // Audience-based display logic (Dallah-style)
          const audienceMatch = clean.match(/(?:DISPLAY_IF:\s*|SHOW\s+(?:ONLY\s+)?TO\s+)(.+)/i) ||
                                clean.match(/(?:ONLY\s+(?:FOR|TO)\s+)(.+)/i)
          if (audienceMatch && respTypeQid) {
            const audience = audienceMatch[1].trim().toLowerCase().replace(/\s*who\s+selected.*$/i,'').replace(/\s*\(.*$/i,'').trim()
            const mapping = audienceToChoice[audience]
            if (mapping) {
              q.displayLogic = q.displayLogic || { conditions: [] }
              const exists = q.displayLogic.conditions.some(c => c.questionId === respTypeQid && c.choiceIndex === mapping.index)
              if (!exists) { q.displayLogic.conditions.push({ questionId:respTypeQid, choiceIndex:mapping.index, choiceText:mapping.text, operator:'Selected', connector:'And' }); appliedCount++ }
            }
          }
        }
      }
    }

    // ── Apply SHOW IF display logic (from structured-spec format) ──
    try { structure = applyShowIfToStructure(structure) } catch(e) { console.warn('applyShowIf:', e.message) }

    // Clean _srcRouting AFTER applyShowIfToStructure has used it
    structure.blocks.forEach(b => b.questions?.forEach(q => delete q._srcRouting))

    // ── Apply AI-extracted rules to structure ──
    const aiRules = logicMap?.rules || []
    let aiAppliedCount = 0
    if (aiRules.length > 0) {
      // Build QID lookup: tag → QID (e.g., "S.3" → "QID3")
      const aiQidMap = {}
      structure.blocks.forEach(b => b.questions?.forEach(q => {
        if (q.dataExportTag) { aiQidMap[q.dataExportTag] = q.id; aiQidMap[q.dataExportTag.toLowerCase()] = q.id; aiQidMap[q.dataExportTag.toUpperCase()] = q.id }
      }))
      // Also use the AI's own qidMap
      if (logicMap.qidMap) Object.entries(logicMap.qidMap).forEach(([tag, qid]) => { aiQidMap[tag] = qid; aiQidMap[tag.toLowerCase()] = qid })

      for (const rule of aiRules) {
        const srcQid = aiQidMap[rule.sourceQuestion] || aiQidMap[rule.sourceQID] || rule.sourceQID || rule.sourceQuestion
        const tgtQid = aiQidMap[rule.action?.targetQuestion] || aiQidMap[rule.action?.targetQID] || rule.action?.targetQID

        if (rule.type === 'DisplayLogic' && tgtQid) {
          // Find target question and add displayLogic
          for (const b of structure.blocks) {
            for (const q of (b.questions || [])) {
              if (q.id === tgtQid || q.dataExportTag === rule.action?.targetQuestion) {
                q.displayLogic = q.displayLogic || { conditions: [] }
                const exists = q.displayLogic.conditions.some(c => c.questionId === srcQid && c.choiceText === rule.condition?.choiceText)
                if (!exists) {
                  q.displayLogic.conditions.push({
                    questionId: srcQid, choiceIndex: rule.condition?.choiceIndex || 1,
                    choiceText: rule.condition?.choiceText || '', operator: rule.condition?.operator || 'Selected', connector: 'And'
                  })
                  aiAppliedCount++
                }
              }
            }
          }
        } else if ((rule.type === 'SkipLogic' || rule.type === 'EndSurvey') && srcQid) {
          // Find source question and add skipLogic terminate
          for (const b of structure.blocks) {
            for (const q of (b.questions || [])) {
              if (q.id === srcQid || q.dataExportTag === rule.sourceQuestion) {
                q.skipLogic = q.skipLogic || { rules: [] }
                const exists = q.skipLogic.rules.some(r => r.choiceText === rule.condition?.choiceText)
                if (!exists) {
                  q.skipLogic.rules.push({
                    choiceIndex: rule.condition?.choiceIndex || 1, choiceText: rule.condition?.choiceText || '',
                    operator: rule.condition?.operator || 'Selected', destination: 'EndOfSurvey', destinationType: 'EndOfSurvey'
                  })
                  aiAppliedCount++
                }
              }
            }
          }
        }
      }
    }

    // ── STEP 3: Build QSF ──
    if (flowOutline?.length > 0) {
      try {
        const blockDescMap = {}; structure.blocks.forEach(b => { blockDescMap[b.description] = b.id })
        const qidLookup = {}; structure.blocks.forEach(b => b.questions?.forEach(q => { if (q.dataExportTag) qidLookup[q.dataExportTag] = q.id }))
        const builtFlow = flowOutlineToSurveyFlow(flowOutline, blockDescMap, qidLookup)
        if (builtFlow.length > 0) {
          if (builtFlow[builtFlow.length-1]?.type !== 'EndSurvey') builtFlow.push({ type:'EndSurvey' })
          structure.surveyFlow = builtFlow
        }
      } catch(e) {}
    }
    if (embeddedData.length > 0) {
      structure.surveyFlow = [{ type:'EmbeddedData', fields:embeddedData }, ...structure.surveyFlow]
    }
    structure = normalizeQIDs(structure)
    const groundingReport = validateGrounding(structure, fileText)

    const qsf = buildQSF(structure, { brandId: brandId || 'qualtricsxm52yzcwcsx' })

    // ── Compute stats for KPI display ──
    let detDisplayLogic = 0, detSkipLogic = 0, detFlowBranches = 0, showIfCount = 0
    structure.blocks.forEach(b => b.questions?.forEach(q => {
      if (q.displayLogic?.conditions?.length) detDisplayLogic++
      if (q.skipLogic?.rules?.length) detSkipLogic++
    }))
    if (structure.surveyFlow) {
      detFlowBranches = structure.surveyFlow.filter(f => f.type === 'Branch').length
    }
    const stats = {
      format: fmt,
      sections: sections.length,
      totalQuestions: totalQ,
      totalBlocks: structure.blocks.length,
      embeddedDataFields: embeddedData.length,
      flowOutlineItems: flowOutline?.length || 0,
      deterministic: {
        displayLogic: detDisplayLogic,
        skipLogic: detSkipLogic,
        flowBranches: detFlowBranches,
        audienceRouting: appliedCount,
        total: detDisplayLogic + detSkipLogic + detFlowBranches + appliedCount
      },
      ai: {
        model: 'claude-haiku-4-5-20251001',
        rulesExtracted: logicMap?.rules?.length || 0,
        rulesApplied: aiAppliedCount,
      },
      groundingScore: groundingReport?.score || null,
    }

    // ── Save + consume credit ──
    let surveyRecord = null
    if (req.dbUser?.id) {
      const { rows } = await pool.query(`
        INSERT INTO surveys (user_id, name, structure, qsf, logic_map, file_text)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [req.dbUser.id, structure.surveyName||'Survey', JSON.stringify(structure), JSON.stringify(qsf), JSON.stringify(logicMap), fileText.slice(0,50000)])
      surveyRecord = rows[0]

      await pool.query('UPDATE users SET surveys_created=surveys_created+1, credits_used=credits_used+1 WHERE id=$1', [req.dbUser.id])
      await pool.query('INSERT INTO usage_log (user_id, action, meta) VALUES ($1,$2,$3)',
        [req.dbUser.id, 'generate', JSON.stringify({ surveyId:surveyRecord?.id, questions:totalQ, routing:appliedCount })])
    }

    const user = req.dbUser
    const creditsRemaining = Math.max(0, (user.credits||3) - (user.credits_used||0) - 1)

    res.json({ structure, surveyId: surveyRecord?.id, qsf, creditsRemaining, stats })
  } catch(e) {
    console.error('Build error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── CRITIQUE ─────────────────────────────────────────────────────────────
router.post('/critique', async (req, res) => {
  const { fileText } = req.body
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY
  const system = `You are a senior market research methodologist. Analyze the questionnaire and return structured JSON critique.`
  const prompt = `Analyze this questionnaire for MR quality issues:\n\n${(fileText||'').slice(0,8000)}\n\nReturn ONLY this JSON:\n{"overallScore":72,"overallGrade":"B","summary":"3-sentence summary","estimatedLOI":12,"issues":[{"severity":"Critical|Major|Minor","category":"Structure|Question Quality|Routing|Coding","question":"Q3","issue":"desc","recommendation":"fix"}],"strengths":["good"],"missingElements":["missing"]}`

  try {
    const { text: raw, tokens } = await callClaude(apiKey, system, prompt, 4096)
    const clean = raw.replace(/```json|```/g,'').trim()
    let critique
    try { critique = JSON.parse(clean) } catch { critique = { overallScore:0, issues:[], summary:'Parse error' } }
    if (req.dbUser?.id) {
      await pool.query('INSERT INTO usage_log (user_id, action, tokens) VALUES ($1,$2,$3)', [req.dbUser.id, 'critique', tokens]).catch(()=>{})
      await pool.query('UPDATE users SET tokens_used=tokens_used+$1 WHERE id=$2', [tokens, req.dbUser.id]).catch(()=>{})
    }
    res.json({ critique })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── DEBRIEF EXPORT ───────────────────────────────────────────────────────
router.post('/debrief', async (req, res) => {
  const { structure } = req.body
  if (!structure?.blocks) return res.status(400).json({ error: 'No structure' })
  const lines = []
  const now = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
  lines.push(`# SURVEY PROGRAMMING SPECIFICATION\n**Survey:** ${structure.surveyName||'Survey'}\n**Date:** ${now}\n**Generated by:** Tusk.AI\n\n---\n`)
  let qNum = 0
  for (const block of structure.blocks) {
    lines.push(`## ${block.description||'Block'}`)
    for (const q of (block.questions||[])) {
      qNum++
      const label = q.dataExportTag || ('Q'+qNum)
      lines.push(`### ${label}. ${q.questionText}`)
      lines.push(`**Type:** ${q.type}${q.multiSelect?' (Multi)':''} | **Required:** ${q.required?'Yes':'No'}`)
      if (q.choices?.length) lines.push(`**Choices:** ${q.choices.map((c,i)=>`${i+1}. ${typeof c==='string'?c:c.text||c.Display}`).join(' | ')}`)
      if (q.skipLogic?.rules?.length) lines.push(`**Routing:** ${q.skipLogic.rules.map(r=>`IF "${r.choiceText}"→${r.destination}`).join('; ')}`)
      if (q.displayLogic?.conditions?.length) lines.push(`**Show if:** ${q.displayLogic.conditions.map(c=>`${c.questionId} ${c.operator} "${c.choiceText}"`).join(' AND ')}`)
      lines.push('')
    }
    lines.push('---\n')
  }
  if (req.dbUser?.id) await pool.query('INSERT INTO usage_log (user_id, action) VALUES ($1,$2)', [req.dbUser.id,'debrief']).catch(()=>{})
  res.json({ markdown: lines.join('\n'), surveyName: structure.surveyName })
})

// ── DOWNLOAD QSF ─────────────────────────────────────────────────────────
router.post('/download-qsf', async (req, res) => {
  const { structure, brandId } = req.body
  if (!structure?.blocks) return res.status(400).json({ error: 'No structure' })
  const qsf = buildQSF(structure, { brandId: brandId || 'qualtricsxm52yzcwcsx' })
  res.json({ qsf, surveyId: qsf.SurveyEntry.SurveyID })
})

// ── LIST USER SURVEYS ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, status, qualtrics_id, created_at, updated_at FROM surveys WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50',
      [req.dbUser?.id]
    )
    res.json({ surveys: rows })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── SAVE/UPDATE SURVEY ───────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { structure, qsf, qualtrics_id, status } = req.body
  try {
    const { rows } = await pool.query(`
      UPDATE surveys SET
        structure=COALESCE($1::jsonb,structure), qsf=COALESCE($2::jsonb,qsf),
        qualtrics_id=COALESCE($3,qualtrics_id), status=COALESCE($4,status), updated_at=NOW()
      WHERE id=$5 AND user_id=$6 RETURNING *
    `, [structure?JSON.stringify(structure):null, qsf?JSON.stringify(qsf):null, qualtrics_id||null, status||null, req.params.id, req.dbUser?.id])
    res.json({ survey: rows[0] })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

export default router

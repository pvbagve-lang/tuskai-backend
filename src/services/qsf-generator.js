// qsf-generator.js — QualtricsAI v4
// Schema validated against two real Qualtrics exports:
//   Test_PB.qsf (complex survey, many blocks)
//   Test_PB_16_March.qsf (survey with branch logic)

// ── Quota Builder ─────────────────────────────────────────────────────────
export function buildQuotas(quotaSpecs, qidOrder) {
  // quotaSpecs: [{ name, count, conditions: [{questionId, choiceIndex, choiceText, operator}] }]
  if (!quotaSpecs || !quotaSpecs.length) return [];

  function randId(n) {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({length:n}, ()=>c[Math.floor(Math.random()*c.length)]).join('');
  }

  return quotaSpecs.map((spec, idx) => {
    const qoId = 'QO_' + randId(15);
    const conditions = (spec.conditions || []).map((c, ci) => {
      const genQid = qidOrder[c.questionId] !== undefined
        ? 'QID' + (qidOrder[c.questionId]+1)
        : c.questionId;
      const loc = 'q://' + genQid + '/SelectableChoice/' + (c.choiceIndex || 1);
      return {
        QuotaConditionID: 'QC_' + randId(15),
        LogicType:        'Question',
        QuestionID:       genQid,
        QuestionIsInLoop: 'no',
        ChoiceLocator:    loc,
        Operator:         c.operator || 'Selected',
        LeftOperand:      loc,
        QuestionIDFromLocator: genQid,
        Type:             'Expression',
        Description:      genQid + ' ' + (c.operator||'Selected') + ' ' + (c.choiceText||'')
      };
    });

    return {
      ID:            qoId,
      Name:          spec.name || ('Quota ' + (idx+1)),
      Occurrences:   spec.count || 100,
      Logic: {
        '0': {
          '0': conditions[0] || {},
          ...(conditions.slice(1).reduce((acc,c,i)=>({...acc,[String(i+1)]:{...c,Conjuction:'And'}}),{})),
          Type: 'If'
        },
        Type: 'BooleanExpression'
      },
      QuotaAction:      'EndCurrentSurvey',
      ActionElement:    'ENDOFSURVEY',
      ActionInfo:       { Type: 'EndCurrentSurvey', LogicType: 'QuotaMet' },
      QuotaSchedule:    null,
      Count:            0,
      WebServiceOptions: { active: false, url: '' },
      OverQuotaOptions: { Type: 'EndCurrentSurvey' },
      QuotaRealm:       'Survey',
      CrossLogicDef:    [],
      PerformActionOn:  'everyEntry'
    };
  });
}

export function buildQSF(structure, options = {}) {
  const sid  = 'SV_' + randId(15);
  const rsid = 'RS_' + randId(15);
  const now  = fmtDate(new Date());
  const name = clean(structure.surveyName || 'Generated Survey');

  // ── SurveyEntry — TOP LEVEL ONLY, never inside SurveyElements ────────────
  const surveyEntry = {
    SurveyID:                sid,
    SurveyName:              name,
    SurveyDescription:       null,
    SurveyOwnerID:           (options && options.ownerId) || 'UR_00000000000000',
    SurveyBrandID:           (options && options.brandId) || '',
    DivisionID:              null,
    SurveyLanguage:          'EN',
    SurveyActiveResponseSet: rsid,
    SurveyStatus:            'Inactive',
    SurveyStartDate:         '0000-00-00 00:00:00',
    SurveyExpirationDate:    '0000-00-00 00:00:00',
    SurveyCreationDate:      now,
    CreatorID:               (options && options.ownerId) || 'UR_00000000000000',
    LastModified:            now,
    LastAccessed:            '0000-00-00 00:00:00',
    LastActivated:           '0000-00-00 00:00:00',
    Deleted:                 null
  };

  // ── Build blocks (BL Payload = object with numeric string keys) ───────────
  // Format: {"0": {block}, "1": {trash}, "2": {block}, ...}
  // First block = Type:'Default', second = Type:'Trash', rest = Type:'Standard'
  const blArr  = [];   // list of block objects (Qualtrics expects array)
  const sqEls  = [];   // individual SQ elements
  let   qNum   = 0;
  let   flNum  = 2;
  const fid    = () => 'FL_' + (flNum++);

  // QID order index for display logic forward-ref guard
  const qidOrder = {};
  let   oi = 0;
  for (const b of (structure.blocks || []))
    for (const q of (b.questions || []))
      if (q.id) qidOrder[q.id] = oi++;

  const trashBid = newBLId();
  // Map AI-provided block IDs → generated valid BL_ IDs
  const bidMap = {};
  for (const block of (structure.blocks || [])) {
    if (block.id) bidMap[block.id] = newBLId();
  }

  // ── Auto-promote shared displayLogic → block.includeIf ──────────────────
  // If every question in a block shares identical displayLogic conditions,
  // treat it as a section-level condition (FL Branch) instead of per-question logic.
  for (const block of (structure.blocks || [])) {
    if (block.includeIf) continue; // already set
    const qs = (block.questions || []).filter(q => q.displayLogic?.conditions?.length > 0);
    if (qs.length === 0 || qs.length !== block.questions?.length) continue;

    // Check if all questions share the same first condition's questionId + choiceIndex
    const ref = qs[0].displayLogic.conditions;
    const allSame = qs.every(q => {
      const c = q.displayLogic.conditions;
      return c.length === ref.length &&
        c.every((ci, i) =>
          ci.questionId === ref[i].questionId &&
          ci.choiceIndex === ref[i].choiceIndex &&
          ci.operator   === ref[i].operator
        );
    });

    if (allSame) {
      // Promote to block.includeIf, strip displayLogic from all questions
      block.includeIf = ref;
      for (const q of block.questions) delete q.displayLogic;
    }
  }

  // skipTailBlocks: map from original block id → { tailBid, skipQid, skipChoiceIndex, skipChoiceText }
  // Used by flow builder to insert Branch nodes for skip-to-end-of-block
  const skipTailBlocks = {};

  for (let bi = 0; bi < (structure.blocks || []).length; bi++) {
    const block   = structure.blocks[bi];
    const bid     = bidMap[block.id] || newBLId();
    const isFirst = (bi === 0);
    const questions = block.questions || [];

    // Detect split point: first question with EndOfBlock skip rule
    // EndOfSurvey is handled by SkipLogic on the question itself, no block split needed
    let splitIdx  = -1;
    let skipRule  = null;
    let skipQid   = null;
    let splitType = null;
    for (let qi = 0; qi < questions.length; qi++) {
      const rules = questions[qi].skipLogic?.rules || [];
      const eob = rules.find(r => r.destination === 'EndOfBlock');
      if (eob) {
        splitIdx  = qi;
        skipRule  = eob;
        splitType = 'EndOfBlock';
        break;
      }
    }

    // Build head refs (up to and including split question) and tail refs (after)
    const headRefs = [];
    const tailRefs = [];
    for (let qi = 0; qi < questions.length; qi++) {
      qNum++;
      const qid = 'QID' + qNum;
      if (qi === splitIdx) skipQid = qid;
      sqEls.push(buildSQ(questions[qi], qid, sid, qidOrder));
      if (splitIdx < 0 || qi <= splitIdx) {
        headRefs.push({ Type: 'Question', QuestionID: qid });
      } else {
        tailRefs.push({ Type: 'Question', QuestionID: qid });
      }
    }

    if (isFirst) {
      // Default block always gets ALL questions — no splitting
      // Skip logic within the screener is handled by BranchLogic in the Flow
      const allRefs = [...headRefs, ...tailRefs];
      blArr.push({ Type:'Default', Description:'Default Question Block', ID:bid, BlockElements:allRefs });
      blArr.push({ Type:'Trash', Description:'Trash / Unused Questions', ID:trashBid, BlockElements:[] });
      // Reset tail so the tail block isn't created below
      tailRefs.length = 0;
    } else {
      // Build block options — add Loop & Merge if block has loopSourceQid
      const blockOptions = { BlockLocking:'false', RandomizeQuestions:'false' };

      if (block.loopSourceQid) {
        // Find the source question to get its choices for Static keys
        const sourceQ = (structure.blocks || [])
          .flatMap(b => b.questions || [])
          .find(q => q.id === block.loopSourceQid);

        // Build Static: one key per choice index, each mapped to []
        const staticKeys = {};
        if (sourceQ?.choices) {
          sourceQ.choices.forEach((_, i) => { staticKeys[String(i+1)] = []; });
        } else {
          // Fallback: use 8 slots (typical multi-select)
          for (let k = 1; k <= 8; k++) staticKeys[String(k)] = [];
        }

        // Resolve source QID (the generated QID for loopSourceQid)
        const sourceGenQid = qidOrder[block.loopSourceQid] !== undefined
          ? 'QID' + (qidOrder[block.loopSourceQid] + 1)
          : block.loopSourceQid;

        blockOptions.Looping = 'Question';
        blockOptions.LoopingOptions = {
          Locator:            'q://' + sourceGenQid + '/ChoiceGroup/SelectedChoices',
          QID:                sourceGenQid,
          ChoiceGroupLocator: 'q://' + sourceGenQid + '/ChoiceGroup/SelectedChoices',
          Static:             staticKeys,
          Randomization:      'None'
        };
      }

      blArr.push({
        Type:'Standard', SubType:'', ID:bid,
        Description: clean(block.description || ('Block ' + bi)).slice(0, 200),
        BlockElements: headRefs,
        Options: blockOptions
      });
    }

    // If split needed, create tail block
    if (splitIdx >= 0 && tailRefs.length > 0) {
      const tailBid = newBLId();
      blArr.push({
        Type:'Standard', SubType:'', ID:tailBid,
        Description: clean(block.description || ('Block ' + bi)).slice(0, 200) + ' (cont.)',
        BlockElements: tailRefs,
        Options: { BlockLocking:'false', RandomizeQuestions:'false', BlockVisibility:'Expanded' }
      });
      skipTailBlocks[block.id] = {
        tailBid,
        skipQid,
        splitType,
        skipChoiceIndex: skipRule.choiceIndex || 1,
        skipChoiceText:  skipRule.choiceText  || ''
      };
    }
  }

  // ── Build Survey Flow ─────────────────────────────────────────────────────
  // Inject EmbeddedData element first if defined
  const flowItems = [];
  const edFields  = structure.embeddedData || [];

  if (edFields.length > 0) {
    flowItems.push({
      Type:         'EmbeddedData',
      FlowID:       fid(),
      EmbeddedData: edFields.map(f => ({
        Description:   f.name,
        Type:          f.type || 'Custom',
        Field:         f.name,
        VariableType:  f.variableType || 'String',
        DataVisibility: [],
        AnalyzeText:   false,
        Value:         f.value || ''
      }))
    });
    console.log && console.log(`  Added ${edFields.length} embedded data fields to flow`);
  }

  let   firstBlock = true;

  // Pre-collect EOS/EOB rules regardless of flow path
  const eosRulesGlobal = [];
  for (const block of (structure.blocks || [])) {
    for (const q of (block.questions || [])) {
      // Only apply skip logic to MC questions with actual choices
      if (!q.choices || q.choices.length === 0) continue;
      if (q.type === 'TE' || q.type === 'DB') continue;
      const rules = q.skipLogic?.rules || [];
      for (const eos of rules.filter(r => r.destination === 'EndOfSurvey')) {
        // Verify choiceIndex is within actual choices range
        if (eos.choiceIndex > 0 && eos.choiceIndex <= q.choices.length) {
          eosRulesGlobal.push({
            qid: q.id, choiceIndex: eos.choiceIndex || 2,
            choiceText: eos.choiceText || '', blockId: block.id
          });
        }
      }
    }
  }
  const tailBidSetGlobal = new Set(Object.values(skipTailBlocks).map(v => v.tailBid));

  function addBlockWithBranches(blockOrigId, blType) {
    const cleanId = bidMap[blockOrigId];
    if (!cleanId) return;

    // Check if block has section-level include condition
    const block = (structure.blocks || []).find(b => b.id === blockOrigId);
    const includeIf = block?.includeIf; // { questionId, choiceIndex, choiceText, operator, connector }[]

    if (includeIf && includeIf.length > 0) {
      // Wrap entire block in a Branch node
      const branchLogic = buildBlockBranchLogic(includeIf);
      const innerFlowId = fid();
      flowItems.push({
        Type: 'Branch', FlowID: fid(), Description: 'New Branch',
        BranchLogic: branchLogic,
        Flow: [{ Type: blType, ID: cleanId, FlowID: innerFlowId, Autofill: [] }]
      });
      firstBlock = false;
    } else {
      flowItems.push({ Type: blType, ID: cleanId, FlowID: fid(), Autofill: [] });
      firstBlock = false;
    }

    // EndOfSurvey branches after this block — using Branch→EndSurvey in flow (Qualtrics native format)
    const splitQids = Object.values(skipTailBlocks).map(v => v.skipQid);
    for (const eos of eosRulesGlobal.filter(r => r.blockId === blockOrigId && !splitQids.includes(r.qid))) {
      const loc = 'q://' + eos.qid + '/SelectableChoice/' + eos.choiceIndex;
      flowItems.push({
        Type:'Branch', FlowID:fid(), Description:'New Branch',
        BranchLogic:{'0':{'0':{LogicType:'Question',QuestionID:eos.qid,QuestionIsInLoop:'no',
          ChoiceLocator:loc,Operator:'Selected',QuestionIDFromLocator:eos.qid,
          LeftOperand:loc,Type:'Expression',
          Description:`<span class="ConjDesc">If</span> <span class="QuestionDesc">${eos.qid}</span> <span class="LeftOpDesc">${eos.choiceText}</span> <span class="OpDesc">Is Selected</span> `},
          Type:'If'},Type:'BooleanExpression'},
        Flow:[{Type:'EndSurvey',FlowID:fid()}]
      });
    }
    // Skip-tail branch after this block
      // Handle split block tail based on splitType
      const tailInfo = skipTailBlocks[blockOrigId];
      if (tailInfo) {
        const loc = 'q://' + tailInfo.skipQid + '/SelectableChoice/' + tailInfo.skipChoiceIndex;

        if (tailInfo.splitType === 'EndOfSurvey') {
          // TERMINATE: Branch(IF condition Selected) → EndSurvey
          // Remaining questions in block shown unconditionally (only reached if not terminated)
          flowItems.push({
            Type:'Branch', FlowID:fid(), Description:'New Branch',
            BranchLogic:{'0':{'0':{
              LogicType:'Question', QuestionID:tailInfo.skipQid, QuestionIsInLoop:'no',
              ChoiceLocator:loc, Operator:'Selected', QuestionIDFromLocator:tailInfo.skipQid,
              LeftOperand:loc, Type:'Expression',
              Description:tailInfo.skipQid+' Selected '+tailInfo.skipChoiceText
            }, Type:'If'}, Type:'BooleanExpression'},
            Flow:[{Type:'EndSurvey', FlowID:fid()}]
          });
          // Tail always shown if respondent was not terminated
          flowItems.push({ Type:'Standard', ID:tailInfo.tailBid, FlowID:fid(), Autofill:[] });

        } else {
          // SKIP TO END OF BLOCK: Branch(IF NOT selected) → tail (Q4, Q5 etc.)
          flowItems.push({
            Type:'Branch', FlowID:fid(), Description:'New Branch',
            BranchLogic:{'0':{'0':{
              LogicType:'Question', QuestionID:tailInfo.skipQid, QuestionIsInLoop:'no',
              ChoiceLocator:loc, Operator:'NotSelected', QuestionIDFromLocator:tailInfo.skipQid,
              LeftOperand:loc, Type:'Expression',
              Description:tailInfo.skipQid+' NotSelected '+tailInfo.skipChoiceText
            }, Type:'If'}, Type:'BooleanExpression'},
            Flow:[{Type:'Standard', ID:tailInfo.tailBid, FlowID:fid(), Autofill:[]}]
          });
        }
      }
  }

  if (structure.surveyFlow && structure.surveyFlow.length > 0) {
    for (const f of structure.surveyFlow) {
      if (!f || f.type === 'EndSurvey' || f.type === 'EmbeddedData') continue;
      if ((f.type === 'Block' || f.type === 'Standard') && f.id) {
        addBlockWithBranches(f.id, firstBlock ? 'Block' : 'Standard');
      } else if (f.type === 'Branch' && f.condition && f.condition.questionId) {
        const branch = buildBranch(f, fid, bidMap);
        if (branch) { flowItems.push(branch); firstBlock = false; }
      }
    }
  } else {
    // Auto-build from blocks using same addBlockWithBranches helper
    for (const block of (structure.blocks || [])) {
      const bid = bidMap[block.id];
      if (!bid || tailBidSetGlobal.has(bid)) continue;
      addBlockWithBranches(block.id, firstBlock ? 'Block' : 'Standard');
    }
  }

  flowItems.push({ Type: 'EndSurvey', FlowID: fid() });

  // Sanitize: remove any Branch nodes with empty Flow[] — Qualtrics rejects these
  function sanitizeFlow(items) {
    return items
      .filter(f => !(f.Type === 'Branch' && (!f.Flow || f.Flow.length === 0)))
      .map(f => f.Flow ? { ...f, Flow: sanitizeFlow(f.Flow) } : f);
  }
  const safeFlowItems = sanitizeFlow(flowItems);

  // ── Assemble SurveyElements ───────────────────────────────────────────────
  const mk = (el, pa, sa, ta, pl) => ({
    SurveyID:           sid,
    Element:            el,
    PrimaryAttribute:   pa,
    SecondaryAttribute: sa || null,
    TertiaryAttribute:  ta || null,
    Payload:            pl
  });

  const surveyElements = [
    // BL — single element, Payload is object with numeric string keys
    mk('BL', 'Survey Blocks', null, null, blArr),

    // FL — root flow
    mk('FL', 'Survey Flow', null, null, {
      Type:       'Root',
      FlowID:     'FL_1',
      Flow:       safeFlowItems,
      Properties: { Count: safeFlowItems.length }
    }),

    // PL — preview link
    mk('PL', 'Preview Link', null, null, {
      PreviewType: 'Brand',
      PreviewID:   uuidv4()
    }),

    // PROJ
    mk('PROJ', 'CORE', null, '1.1.0', {
      ProjectCategory: 'CORE',
      SchemaVersion:   '1.1.0'
    }),

    // QC
    mk('QC', 'Survey Question Count', String(sqEls.length), null, null),

    // RS — Payload is null
    mk('RS', rsid, 'Default Response Set', null, null),

    // SCO
    mk('SCO', 'Scoring', null, null, {
      ScoringCategories:         [],
      ScoringCategoryGroups:     [],
      ScoringSummaryCategory:    null,
      ScoringSummaryAfterQuestions: 0,
      ScoringSummaryAfterSurvey: 0,
      DefaultScoringCategory:    null,
      AutoScoringCategory:       null
    }),

    // SO — full payload matching real Qualtrics exports (Test_PB.qsf reference)
    mk('SO', 'Survey Options', null, null, {
      BackButton:                  'false',
      SaveAndContinue:             'true',
      SurveyProtection:            'PublicSurvey',
      BallotBoxStuffingPrevention: 'false',
      NoIndex:                     'Yes',
      SecureResponseFiles:         'true',
      SurveyExpiration:            'None',
      SurveyTermination:           'DefaultMessage',
      Header:                      '',
      Footer:                      '',
      ProgressBarDisplay:          'None',
      PartialData:                 '+1 week',
      ValidationMessage:           '',
      PreviousButton:              '',
      NextButton:                  '',
      SurveyTitle:                 'Qualtrics Survey | Qualtrics Experience Management',
      SkinLibrary:                 (options && options.brandId) || 'qualtrics',
      SkinType:                    'component',
      Skin: {
        brandingId: null,
        templateId: '*simple',
        overrides:  null
      },
      NewScoring:            1,
      SurveyMetaDescription: 'The most powerful, simple and trusted way to gather experience data.',
      SurveyName:            name,
      EOSMessage:                              null,
      ShowExportTags:                          'true',
      CollectGeoLocation:                      'false',
      PasswordProtection:                      'No',
      AnonymizeResponse:                       'No',
      RefererCheck:                            'No',
      BallotBoxStuffingPreventionBehavior:     null,
      BallotBoxStuffingPreventionMessage:      null,
      BallotBoxStuffingPreventionMessageLibrary: null,
      BallotBoxStuffingPreventionURL:          null,
      UseCustomSurveyLinkCompletedMessage:     null,
      SurveyLinkCompletedMessage:              null,
      SurveyLinkCompletedMessageLibrary:       null,
      ResponseSummary:                         'No',
      EOSMessageLibrary:                       null,
      EOSRedirectURL:                          null,
      EmailThankYou:                           'false',
      ThankYouEmailMessageLibrary:             null,
      ThankYouEmailMessage:                    null,
      ValidateMessage:                         'true',
      ValidationMessageLibrary:                null,
      InactiveSurvey:                          'DefaultMessage',
      PartialDeletion:                         null,
      PartialDataCloseAfter:                   'LastActivity',
      InactiveMessageLibrary:                  null,
      InactiveMessage:                         null,
      AvailableLanguages:                      { EN: [] }
    }),

    // SQ elements
    ...sqEls,

    // STAT
    mk('STAT', 'Survey Statistics', null, null, {
      MobileCompatible: true,
      ID:               'Survey Statistics'
    })
  ];

  return { SurveyEntry: surveyEntry, SurveyElements: surveyElements };
}

// ── Question builder ──────────────────────────────────────────────────────
function buildSQ(q, qid, sid, qidOrder) {
  const qtype  = getQType(q.type);
  const sel    = getSelector(q);
  const subSel = getSubSelector(q);
  // Resolve piped text placeholders: {pipe:QID1} → ${q://QID1/ChoiceTextEntryValue}
  // Also pass through native Qualtrics piped text ${lm://Field/1} unchanged
  let rawText = q.questionText || 'Question';
  rawText = rawText.replace(/\{pipe:([\w]+)\}/gi, (_, srcId) => {
    // Map AI question id to generated QID
    const genQid = qidOrder[srcId] !== undefined ? 'QID' + (qidOrder[srcId]+1) : srcId;
    return '${q://' + genQid + '/ChoiceTextEntryValue}';
  });
  rawText = rawText.replace(/\{carry:([\w]+)\}/gi, (_, srcId) => {
    const genQid = qidOrder[srcId] !== undefined ? 'QID' + (qidOrder[srcId]+1) : srcId;
    return '${q://' + genQid + '/ChoiceGroup/SelectedChoices}';
  });
  // Resolve piped text: ${variable_name} → ${e://Field/variable_name}
  // Also handle ${q://QIDn/...} which is already in Qualtrics format
  const resolvedText = rawText.replace(/\$\{(?!q:\/\/|lm:\/\/|e:\/\/)([^}]+)\}/g, (_, varName) => {
    return '${e://Field/' + varName.trim() + '}'
  })
  const qtext  = clean(resolvedText);

  // Choices — only {Display} key, no ExclusiveAnswer/TextEntry
  const choices     = {};
  const choiceOrder = [];

  if (q.type === 'NPS') {
    // NPS choices MUST be 1-indexed: key "1"=display "0", key "11"=display "10"
    for (let i = 0; i <= 10; i++) {
      choices[String(i + 1)] = { Display: String(i) };
      choiceOrder.push(i + 1);
    }
  } else if (q.type === 'Matrix') {
    const rows = (q.matrixRows && q.matrixRows.length) ? q.matrixRows : ['Item 1', 'Item 2', 'Item 3'];
    rows.forEach((r, i) => {
      const txt = typeof r === 'object' ? (r.text || r.Display || String(r)) : String(r);
      const entry = { Display: clean(txt) };
      // Support piped text rows (carry-forward)
      if (typeof r === 'object' && r.pipedText) entry.TextEntry = false;
      choices[String(i + 1)] = entry;
      choiceOrder.push(i + 1);
    });
    // Add open-end "Other" row if requested
    if (q.hasOtherRow) {
      const nextIdx = rows.length + 1;
      choices[String(nextIdx)] = { Display: q.otherRowLabel || 'Other (please specify)', TextEntry: true };
      choiceOrder.push(nextIdx);
    }
  } else if (q.type === 'DB') {
    // Descriptive block: NO Choices/ChoiceOrder/SubSelector (same as TE)
  } else if (q.type === 'Slider') {
    choices['1'] = { Display: 'Column 1' };
    choiceOrder.push(1);
  } else if (q.type === 'TE') {
    // Text Entry: leave choices/choiceOrder completely absent (do NOT set empty {} or [])
    // Qualtrics rejects TE with Choices:{} — the key must not exist at all

  } else {
    // MC, CS, RO — must have real choices
    const list = (q.choices && q.choices.length) ? q.choices : [];
    // Only add fallback choices for MC, not for RO/CS which need real content
    const fallback = (q.type === 'MC') ? ['Option 1', 'Option 2', 'Option 3'] : [];
    const finalList = list.length ? list : fallback;
    // Separate anchored choices (none-of-above, n/a etc.) to end
    const exclusivePatterns = /^(none of (the above|these)|n\/a|not applicable|prefer not|no answer|neither|none)/i
    const otherPatterns     = /^other[^a-z]/i
    const anchorPatterns    = /^(none of (the above|these)|n\/a|not applicable|prefer not|no answer|neither)/i

    const normalChoices = finalList.filter(c => {
      const txt = typeof c === 'string' ? c : (c.text || c.Display || '')
      return !anchorPatterns.test(txt.trim())
    })
    const anchoredChoices = finalList.filter(c => {
      const txt = typeof c === 'string' ? c : (c.text || c.Display || '')
      return anchorPatterns.test(txt.trim())
    })
    const orderedList = [...normalChoices, ...anchoredChoices]

    orderedList.forEach((c, i) => {
      const txt = typeof c === 'string' ? c : (c.text || c.Display || String(c));
      const entry = { Display: clean(txt) };
      // Auto-detect exclusive answer (None of the above etc.)
      if (exclusivePatterns.test(txt.trim()) || (typeof c === 'object' && c.exclusive)) {
        entry.ExclusiveAnswer = true;
      }
      // Text entry (Other - specify)
      if (otherPatterns.test(txt.trim()) || (typeof c === 'object' && c.textEntry)) {
        entry.TextEntry = true;
      }
      choices[String(i + 1)] = entry;
      choiceOrder.push(i + 1);
    });
  }

  // Matrix questions also need an Answers object (scale columns)
  let answers = null, answerOrder = null;
  if (q.type === 'Matrix') {
    answers = {};
    answerOrder = [];
    const cols = (q.matrixColumns && q.matrixColumns.length) ? q.matrixColumns
      : ['1 - Strongly Disagree','2','3','4','5 - Strongly Agree'];
    cols.forEach((c, i) => {
      answers[String(i+1)] = { Display: clean(String(c)) };
      answerOrder.push(i+1);
    });
  }

  const payload = {
    QuestionText:        qtext,
    DataExportTag:       sanitizeTag(q.dataExportTag || qid),
    QuestionType:        qtype,
    Selector:            sel,
    ...(subSel !== null ? { SubSelector: subSel } : {}),
    DataVisibility:      { Private: false, Hidden: false },
    Configuration:       { QuestionDescriptionOption: 'UseText' },
    QuestionDescription: qtext.slice(0, 200),
    ...(q.type !== 'TE' && q.type !== 'DB' ? { Choices: choices, ChoiceOrder: choiceOrder } : {}),
    ...(answers ? { Answers: answers, AnswerOrder: answerOrder } : {}),
    Validation: {
      Settings: {
        ForceResponse:     q.required ? 'ON' : 'OFF',
        Type:              'None'
      }
    },
    Language:      [],
    ...(q.type === 'TE' ? { SearchSource: { AllowFreeResponse: 'false' } } : {}),
    NextChoiceId:  q.type === 'TE' ? 1 : choiceOrder.length + 1,
    NextAnswerId:  1,
    QuestionID:    qid
  };

  // Matrix answers
  if (q.type === 'Matrix') {
    const cols = (q.matrixColumns && q.matrixColumns.length) ? q.matrixColumns
               : ['Strongly Agree', 'Agree', 'Neutral', 'Disagree', 'Strongly Disagree'];
    const answers = {};
    const answerOrder = [];
    cols.forEach((c, i) => {
      answers[String(i + 1)] = { Display: clean(String(c)) };
      answerOrder.push(i + 1);
    });
    payload.Answers      = answers;
    payload.AnswerOrder  = answerOrder;
    payload.NextAnswerId = cols.length + 1;
  }

  // NPS labels
  if (q.type === 'NPS') {
    payload.Configuration.NPSMinLabel = 'Not at all likely';
    payload.Configuration.NPSMaxLabel = 'Extremely likely';
    payload.NextChoiceId = 11;
  }

  // NPS — strip NPSMinLabel/NPSMaxLabel from Configuration (unsupported in import)
  if (q.type === 'NPS') {
    payload.Configuration = { QuestionDescriptionOption: 'UseText' };
    // Fix choices: NPS 0-10, keys must be 1-indexed
    payload.Choices     = {};
    payload.ChoiceOrder = [];
    for (let n = 0; n <= 10; n++) {
      payload.Choices[String(n+1)] = { Display: String(n) };
      payload.ChoiceOrder.push(n+1);
    }
    payload.NextChoiceId = 12;
  }

  // Slider — Configuration extra fields (NumDecimals/MaxValue/MinValue/ShowValue)
  // are NOT used in QSF import — they break Qualtrics file upload
  // Slider uses only base Configuration: {QuestionDescriptionOption:'UseText'}

  // Display Logic
  if (q.displayLogic && q.displayLogic.conditions && q.displayLogic.conditions.length) {
    const dl = buildDisplayLogic(q.displayLogic.conditions, qidOrder, qid);
    if (dl) payload.DisplayLogic = dl;
  }

  // Skip Logic (object with string numeric keys)
  if (q.skipLogic && q.skipLogic.rules && q.skipLogic.rules.length) {
    const sl = buildSkipLogic(q.skipLogic.rules, qid);
    // SkipLogic is NOT set on questions — Qualtrics uses Branch→EndSurvey in flow instead
  }

  // Carry-forward choices from previous question
  // carryForwardQid: DynamicChoices is NOT supported in QSF file import
  // Qualtrics rejects any SQ with DynamicChoices during upload
  // Carry-forward must be configured manually in the Qualtrics UI after import
  // if (q.carryForwardQid) { ... } — intentionally disabled

  if (q.randomizeChoices) {
    payload.Randomization = { Advanced: null, TotalRandSubset: '', Type: 'All' };
  }

  return {
    SurveyID:           sid,
    Element:            'SQ',
    PrimaryAttribute:   qid,
    SecondaryAttribute: qtext.slice(0, 200),
    TertiaryAttribute:  null,
    Payload:            payload
  };
}

// ── Display Logic ─────────────────────────────────────────────────────────
function buildDisplayLogic(conditions, qidOrder, curQid) {
  const result = { Type: 'BooleanExpression', inPage: false };
  let group = 0, added = 0;

  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    if (!c) continue;

    let entry;

    // EmbeddedField condition (embedded data variable check)
    if (c.logicType === 'EmbeddedField' || (!c.questionId && c.field)) {
      entry = {
        LogicType:    'EmbeddedField',
        LeftOperand:  c.field,
        Operator:     c.operator === 'EqualTo' ? 'EqualTo' :
                      c.operator === 'NotEqualTo' ? 'NotEqualTo' :
                      c.operator === 'Contains' ? 'Contains' : 'EqualTo',
        RightOperand: c.value || '',
        Type:         'Expression',
        Description:  (c.field + ' ' + c.operator + ' ' + c.value).trim()
      };
    }
    // Question-based condition
    else if (c.questionId) {
      const sp = qidOrder[c.questionId], cp = qidOrder[curQid];
      if (sp !== undefined && cp !== undefined && sp >= cp) continue;

      let operator = c.operator || 'Selected';
      const isNum  = (c.value != null || c.numericValue != null) &&
        ['LessThan','GreaterThan','EqualTo','NotEqualTo','LessThanOrEqual','GreaterThanOrEqual'].includes(operator);
      const isDisp = operator === 'Displayed';

      if (!isNum && !isDisp && ['LessThan','GreaterThan','LessThanOrEqual','GreaterThanOrEqual'].includes(operator))
        operator = 'Selected';

      const loc = isDisp  ? 'q://' + c.questionId + '/Displayed'
        : isNum  ? 'q://' + c.questionId + '/ChoiceNumericEntryValue'
        : 'q://' + c.questionId + '/SelectableChoice/' + (c.choiceIndex || 1);

      entry = {
        LogicType:             'Question',
        QuestionID:            c.questionId,
        QuestionIsInLoop:      'no',
        ChoiceLocator:         loc,
        Operator:              operator,
        QuestionIDFromLocator: c.questionId,
        LeftOperand:           loc,
        Type:                  'Expression',
        Description:           (c.questionId + ' ' + operator + ' ' + (c.choiceText || c.value || '')).trim()
      };
      if (isNum) entry.RightOperand = String(c.value ?? c.numericValue);
    } else { continue; }

    if (!result[String(group)])
      result[String(group)] = { Type: group === 0 ? 'If' : (c.connector === 'Or' ? 'Or' : 'And') };
    const k = String(Object.keys(result[String(group)]).filter(x => !isNaN(Number(x))).length);
    result[String(group)][k] = entry;
    added++;
    if (i < conditions.length-1 && conditions[i+1] && conditions[i+1].connector !== c.connector) group++;
  }
  return added > 0 ? result : null;
}

// ── Skip Logic (object with string numeric keys) ──────────────────────────
function buildSkipLogic(rules, questionId) {
  if (!rules || !rules.length) return null;
  const qid = questionId || 'self';
  
  // Deduplicate rules by choiceIndex
  const seen = new Set();
  const uniqueRules = rules.filter(r => {
    const key = `${r.choiceIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  if (uniqueRules.length === 0) return null;
  
  const dest = 'ENDOFSURVEY';
  
  // Single rule: simple format
  if (uniqueRules.length === 1) {
    const r = uniqueRules[0];
    const choiceLocator = `q://${qid}/SelectableChoice/${r.choiceIndex || 1}`;
    return {
      '0': {
        '0': {
          LogicType: 'Question', QuestionID: qid, QuestionIsInLoop: 'no',
          ChoiceLocator: choiceLocator, Operator: 'Selected',
          QuestionIDFromLocator: qid, LeftOperand: choiceLocator,
          Type: 'Expression',
          Description: `<span class="Desc">If ${r.choiceText || 'choice'} Is Selected</span>`
        },
        Type: 'If'
      },
      SkipLogicType: 'SimpleSkipLogic',
      SkipToDescription: 'End of Survey',
      SkipToDestination: dest
    };
  }
  
  // Multiple rules: combine with Or conjunction in one group
  const group = { Type: 'If' };
  uniqueRules.forEach((r, i) => {
    const choiceLocator = `q://${qid}/SelectableChoice/${r.choiceIndex || 1}`;
    const expr = {
      LogicType: 'Question', QuestionID: qid, QuestionIsInLoop: 'no',
      ChoiceLocator: choiceLocator, Operator: 'Selected',
      QuestionIDFromLocator: qid, LeftOperand: choiceLocator,
      Type: 'Expression',
      Description: `<span class="Desc">If ${r.choiceText || 'choice'} Is Selected</span>`
    };
    if (i > 0) expr.Conjuction = 'Or';  // Qualtrics uses "Conjuction" (their typo)
    group[String(i)] = expr;
  });
  
  return {
    '0': group,
    SkipLogicType: 'SimpleSkipLogic',
    SkipToDescription: 'End of Survey',
    SkipToDestination: dest
  };
}

// ── Branch flow item ──────────────────────────────────────────────────────
function buildBlockBranchLogic(conditions) {
  const group = { Type: 'If' };
  conditions.forEach((c, i) => {
    const op  = c.operator || 'Selected';
    const loc = 'q://' + c.questionId + '/SelectableChoice/' + (c.choiceIndex || 1);
    const expr = {
      LogicType: 'Question', QuestionID: c.questionId, QuestionIsInLoop: 'no',
      ChoiceLocator: loc, Operator: op,
      QuestionIDFromLocator: c.questionId, LeftOperand: loc,
      Type: 'Expression',
      Description: c.questionId + ' ' + op + ' ' + (c.choiceText || '')
    };
    if (i > 0) expr.Conjuction = (c.connector === 'Or' ? 'Or' : 'And');
    group[String(i)] = expr;
  });
  return { '0': group, Type: 'BooleanExpression' };
}

function buildBranch(f, fid, bidMap) {
  const c        = f.condition || {};
  const operator = c.operator || 'Selected';
  const loc      = 'q://' + c.questionId + '/SelectableChoice/' + (c.choiceIndex || 1);
  const flowItems = (f.flow || []).map(fb => {
    if (fb.type === 'EndSurvey') {
      return { Type: 'EndSurvey', FlowID: fid() };
    }
    if (fb.id && (bidMap[fb.id] || fb.id)) {
      return { Type: 'Standard', ID: bidMap[fb.id] || fb.id, FlowID: fid(), Autofill: [] };
    }
    return null;
  }).filter(Boolean);

  // Don't emit branches with empty Flow — they break Qualtrics import
  if (flowItems.length === 0) return null;

  return {
    Type:        'Branch',
    FlowID:      fid(),
    Description: 'New Branch',
    BranchLogic: {
      '0': {
        '0': {
          LogicType:             'Question',
          QuestionID:            c.questionId,
          QuestionIsInLoop:      'no',
          ChoiceLocator:         loc,
          Operator:              operator,
          QuestionIDFromLocator: c.questionId,
          LeftOperand:           loc,
          Type:                  'Expression',
          Description:           `<span class="ConjDesc">If</span> <span class="QuestionDesc">${c.questionId}</span> <span class="LeftOpDesc">${c.choiceText||''}</span> <span class="OpDesc">Is ${operator}</span> `
        },
        Type: 'If'
      },
      Type: 'BooleanExpression'
    },
    Flow: flowItems
  };
}

// ── Type helpers ──────────────────────────────────────────────────────────
function getQType(t) {
  return {
    MC:'MC', TE:'TE', Matrix:'Matrix', Slider:'Slider',
    NPS:'MC', CS:'CS', DB:'DB', RO:'MC',
    SBS:'SBS', Ranking:'MC'
  }[t] || 'MC';
}
function getSelector(q) {
  const m = {
    MC:     q.multiSelect ? 'MAVR' : 'SAVR',
    TE:     q.longText   ? 'ML'   : 'SL',
    Matrix: q.bipolar    ? 'Bipolar' : 'Likert',
    Slider: 'HSLIDER', NPS:'SAVR', CS:'Allocation', DB:'TB', RO:'MAVR' // NPS/RO unsupported in QSF import → MC
  };
  return m[q.type] || 'SAVR';
}
function getSubSelector(q) {
  if (q.type === 'MC' || q.type === 'NPS') return 'TX';
  if (q.type === 'Matrix') return q.multiSelect ? 'MultipleAnswer' : 'SingleAnswer';
  if (q.type === 'RO') return 'TX'; // RO converted to MC/MAVR
  return null; // null = omit from payload (handled below)
}

// ── Utilities ─────────────────────────────────────────────────────────────
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function clean(text) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}
function sanitizeId(id) {
  // Qualtrics requires exactly BL_<15chars> format
  // Never use AI-provided short IDs — always generate fresh valid ones
  return null; // Force fresh ID generation every time
}

function newBLId()  { return 'BL_' + randId(15); }
function newQIDNum(n) { return 'QID' + n; }
function sanitizeTag(tag) {
  if (!tag) return 'Q1';
  const c = String(tag).replace(/[^a-zA-Z0-9_]/g, '');
  return c || 'Q1';
}
function randId(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
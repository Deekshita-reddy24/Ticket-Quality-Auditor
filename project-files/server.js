const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const Groq = require('groq-sdk');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function isLiveMode() {
  return (
    process.env.NODE_ENV !== 'test' &&
    process.env.GROQ_API_KEY &&
    process.env.GROQ_API_KEY !== 'your_groq_api_key_here'
  );
}

async function callGroq(systemPrompt, userPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    throw new Error("No valid Groq API key found");
  }
  const groq = new Groq({ apiKey });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });
  const text = completion.choices[0]?.message?.content || '{}';
  return JSON.parse(text);
}

// ─── SCORING ENGINE ───────────────────────────────────────────────────────────
// Each dimension scored 0–5, total = sum/15 * 100
// Score NEVER decreases — we always take max(previous, current) per dimension

function scoreDimension_steps(text) {
  // 0 = nothing, 1 = vague mention, 2 = some action words, 3 = partial steps, 4 = numbered steps, 5 = complete numbered steps
  if (!text || text.trim().length < 5) return 0;

  const t = text.toLowerCase();

  const actionWords = ['click', 'open', 'go', 'navigate', 'login', 'select', 'enter',
    'submit', 'press', 'type', 'access', 'upload', 'download', 'install',
    'run', 'tap', 'scroll', 'search', 'visit', 'load', 'refresh'];

  const actionCount = actionWords.filter(w => t.includes(w)).length;

  // Has proper numbered steps like 1. 2. 3.
  const numberedSteps = (t.match(/\b\d+[\.\)]\s+\w/g) || []).length;

  // Has sequence words
  const sequenceWords = ['first', 'then', 'after', 'next', 'finally', 'step', 'following'];
  const hasSequence = sequenceWords.some(w => t.includes(w));

  if (numberedSteps >= 3) return 5;
  if (numberedSteps === 2) return 4;
  if (numberedSteps === 1 || (hasSequence && actionCount >= 2)) return 3;
  if (actionCount >= 2) return 2;
  if (actionCount >= 1 || hasSequence) return 1;
  return 0;
}

function scoreDimension_env(text) {
  if (!text || text.trim().length < 5) return 0;

  const t = text.toLowerCase();

  const browsers = ['chrome', 'firefox', 'safari', 'edge', 'opera', 'brave', 'ie', 'internet explorer'];
  const oses     = ['windows', 'mac', 'macos', 'linux', 'ubuntu', 'android', 'ios', 'iphone', 'ipad'];
  const devices  = ['mobile', 'desktop', 'laptop', 'tablet', 'phone', 'pc', 'computer'];
  const versions = t.match(/v?\d+(\.\d+)+/g) || [];   // e.g. 17.2, v3.1
  const versionWords = ['version', 'v1', 'v2', 'v3', 'v4', 'latest', 'update'];

  const hasBrowser  = browsers.some(b => t.includes(b));
  const hasOS       = oses.some(o => t.includes(o));
  const hasDevice   = devices.some(d => t.includes(d));
  const hasVersion  = versions.length > 0 || versionWords.some(v => t.includes(v));

  let score = 0;
  if (hasBrowser)              score = Math.max(score, 2);
  if (hasOS)                   score = Math.max(score, 2);
  if (hasBrowser && hasOS)     score = Math.max(score, 4);
  if (hasBrowser || hasOS) {
    if (hasVersion || hasDevice) score = Math.max(score, 5);
  }
  // Partial: at least one env-related word
  if (score === 0 && (hasBrowser || hasOS || hasDevice || hasVersion)) score = 1;

  return score;
}

function scoreDimension_expectedActual(text) {
  if (!text || text.trim().length < 5) return 0;

  const t = text.toLowerCase();

  const expectWords  = ['expect', 'should', 'supposed to', 'meant to', 'anticipate'];
  const actualWords  = ['actual', 'instead', 'however', "doesn't", "don't", "won't",
                        "can't", 'unable', 'fail', 'failed', 'error', 'broken',
                        'wrong', 'incorrect', 'not working', 'not work', 'issue',
                        'problem', 'crash', 'blank', 'empty', 'missing'];
  const errorCodes   = t.match(/\b(404|500|403|401|503|4\d\d|5\d\d)\b/g) || [];

  const hasExpect = expectWords.some(w => t.includes(w));
  const hasActual = actualWords.some(w => t.includes(w));
  const hasError  = errorCodes.length > 0;

  if (hasExpect && hasActual)           return 5;
  if (hasExpect && (hasError || text.length > 80)) return 4;
  if (hasActual && hasExpect)           return 4;
  if (hasActual && hasError)            return 3;
  if (hasExpect || (hasActual && text.length > 60)) return 3;
  if (hasActual || hasError)            return 2;
  if (text.trim().length > 20)          return 1;
  return 0;
}

// ─── MAIN AUDIT FUNCTION ──────────────────────────────────────────────────────
// prevScores: the best scores seen so far (so score never decreases)
function simulateAudit(title, description, history = [], prevScores = null) {
  // Combine ALL text for scoring — original + every answer
  const allText = [title, description, ...history.map(h => h.content)].join(' ');

  // Score each dimension on combined text
  let stepsScore        = scoreDimension_steps(allText);
  let envScore          = scoreDimension_env(allText);
  let expectedActualScore = scoreDimension_expectedActual(allText);

  // Title quality bonus: specific title (5+ words) gives +1 to steps & expected/actual
  const titleWords = title.trim().split(/\s+/).length;
  if (titleWords >= 5) {
    stepsScore          = Math.min(stepsScore + 1, 5);
    expectedActualScore = Math.min(expectedActualScore + 1, 5);
  }

  // ANTI-DECREASE: always take the maximum of current vs previous best
  if (prevScores) {
    stepsScore          = Math.max(stepsScore, prevScores.stepsScore || 0);
    envScore            = Math.max(envScore,   prevScores.envScore   || 0);
    expectedActualScore = Math.max(expectedActualScore, prevScores.expectedActualScore || 0);
  }

  // Overall: weighted average out of 100
  // Steps=35%, Env=30%, Expected/Actual=35%
  const overallScore = Math.round(
    (stepsScore / 5)          * 35 +
    (envScore   / 5)          * 30 +
    (expectedActualScore / 5) * 35
  );

  // Clarifying questions — only ask about the weakest dimension
  const clarifyingQuestions = [];
  const titleLower = title.toLowerCase();

  if (stepsScore < 3 && clarifyingQuestions.length < 1) {
    if (titleLower.includes('login') || titleLower.includes('auth') || titleLower.includes('sign')) {
      clarifyingQuestions.push("What exact steps did you follow to log in, and at which step does the issue appear?");
    } else if (titleLower.includes('payment') || titleLower.includes('checkout') || titleLower.includes('billing')) {
      clarifyingQuestions.push("Which payment method were you using and at which step in the checkout did it fail?");
    } else if (titleLower.includes('upload') || titleLower.includes('file') || titleLower.includes('import')) {
      clarifyingQuestions.push("What file type/size were you uploading and what happened after you clicked upload?");
    } else if (titleLower.includes('pdf') || titleLower.includes('download') || titleLower.includes('export')) {
      clarifyingQuestions.push("What steps did you take before clicking export/download, and what happened after?");
    } else if (titleLower.includes('dashboard') || titleLower.includes('access') || titleLower.includes('report')) {
      clarifyingQuestions.push("What did you click or do to reach that page, and what exactly do you see when the issue occurs?");
    } else if (titleLower.includes('database') || titleLower.includes('sql') || titleLower.includes('migration')) {
      clarifyingQuestions.push("What exact command or query triggered the error, and what was the full error message?");
    } else {
      clarifyingQuestions.push("Can you walk us through the exact steps you took that led to this issue?");
    }
  }

  if (envScore < 3 && clarifyingQuestions.length < 1) {
    clarifyingQuestions.push("Which browser and operating system are you using? (e.g. Chrome 121 on Windows 11)");
  }

  if (expectedActualScore < 3 && clarifyingQuestions.length < 1) {
    clarifyingQuestions.push("What did you expect to happen, and what actually occurred instead?");
  }

  // Reasoning text
  const missing = [];
  if (stepsScore < 3)          missing.push("reproduction steps");
  if (envScore < 3)            missing.push("environment info (OS/browser)");
  if (expectedActualScore < 3) missing.push("expected vs actual behavior");

  let reasoning;
  if (overallScore >= 80) {
    reasoning = "Ticket is well-documented with clear steps, environment details, and expected/actual behavior. Ready to assign.";
  } else {
    reasoning = `Steps: ${stepsScore}/5 · Environment: ${envScore}/5 · Expected/Actual: ${expectedActualScore}/5. ${
      missing.length ? `Missing: ${missing.join(', ')}.` : 'Minor details could be improved.'
    }`;
  }

  return { stepsScore, envScore, expectedActualScore, overallScore, reasoning, clarifyingQuestions };
}

function simulateTriage(title, description, history = []) {
  const fullText = [title, description, ...history.map(h => h.content)].join(' ').toLowerCase();

  let assignedTo  = "Backend Team";
  let priority    = "Medium";
  const summary   = `Issue reported: ${title}`;
  let justification = "Relates to general server-side or API behavior.";

  if (['css','layout','display','ui','button','menu','align','style','frontend','design'].some(w => fullText.includes(w))) {
    assignedTo    = "Frontend Team";
    justification = "Involves UI, styling, or client-side rendering.";
  } else if (['database','sql','migration','schema','query','db','mongo','postgres'].some(w => fullText.includes(w))) {
    assignedTo    = "Database Team";
    justification = "Involves database queries, schema, or migrations.";
  } else if (['deploy','docker','aws','cloud','server','devops','pipeline','ci','cd'].some(w => fullText.includes(w))) {
    assignedTo    = "DevOps & Cloud Infrastructure";
    justification = "Relates to infrastructure or deployment.";
  } else if (['test','qa','bug','regression','flaky','unit','integration'].some(w => fullText.includes(w))) {
    assignedTo    = "QA & Testing";
    justification = "Requires testing and quality assurance review.";
  }

  if (['crash','timeout','fail','error','exception','critical'].some(w => fullText.includes(w))) priority = "High";
  if (['production','down','blocking','urgent','all users','outage'].some(w => fullText.includes(w)))   priority = "Critical";
  if (['minor','cosmetic','typo','small','low'].some(w => fullText.includes(w)))                        priority = "Low";

  return { assignedTo, priority, summary, justification };
}

// ─── POST /api/audit/start ────────────────────────────────────────────────────
app.post('/api/audit/start', async (req, res) => {
  const { title, description } = req.body;
  if (!title || !description) {
    return res.status(400).json({ error: "Title and description are required." });
  }

  const sessionId = 'session_' + Date.now();
  const session = {
    id: sessionId, title,
    originalDescription: description,
    history: [], currentAudit: null,
    questionCount: 0, status: 'active', triage: null,
    bestScores: null   // tracks best scores so far
  };
  sessions.set(sessionId, session);

  try {
    let auditResult;

    if (isLiveMode()) {
      const systemPrompt = `You are an expert IT Service Desk AI Auditor. Score this ticket's completeness.

Score these 3 dimensions (each 0–5):
- stepsScore: clear numbered reproduction steps
- envScore: OS, browser, version, device info
- expectedActualScore: what user expected vs what actually happened

Then compute overallScore = round((stepsScore/5)*35 + (envScore/5)*30 + (expectedActualScore/5)*35)

Rules:
- Generate exactly 1 clarifying question for the SINGLE most important missing detail — specific to this ticket.
- Do NOT ask for info already in the ticket.
- If overallScore >= 80, return clarifyingQuestions as [].

JSON only — no markdown:
{"stepsScore":number,"envScore":number,"expectedActualScore":number,"overallScore":number,"reasoning":"string","clarifyingQuestions":["one question"]}`;

      auditResult = await callGroq(systemPrompt, `Title: ${title}\nDescription: ${description}`);
    } else {
      auditResult = simulateAudit(title, description, []);
    }

    session.currentAudit = auditResult;
    session.bestScores = {
      stepsScore: auditResult.stepsScore,
      envScore: auditResult.envScore,
      expectedActualScore: auditResult.expectedActualScore
    };

    const isComplete = auditResult.overallScore >= 80 ||
                       !auditResult.clarifyingQuestions ||
                       auditResult.clarifyingQuestions.length === 0;
    const nextQuestion = isComplete ? null : auditResult.clarifyingQuestions[0];

    let triageResult = null;
    if (isComplete) {
      session.status = 'assigned';
      triageResult = isLiveMode()
        ? await callGroq(
            `Route this ticket. Pick ONE: Frontend Team, Backend Team, Database Team, DevOps & Cloud Infrastructure, QA & Testing.
JSON only: {"assignedTo":"string","priority":"Low|Medium|High|Critical","summary":"one sentence","justification":"reason"}`,
            `Title: ${title}\nDescription: ${description}`)
        : simulateTriage(title, description, []);
      session.triage = triageResult;
    }

    res.json({
      sessionId,
      mode: isLiveMode() ? 'live-ai' : 'sandbox-simulation',
      scores: {
        stepsScore: auditResult.stepsScore,
        envScore: auditResult.envScore,
        expectedActualScore: auditResult.expectedActualScore,
        overallScore: auditResult.overallScore
      },
      reasoning: auditResult.reasoning,
      nextQuestion,
      isComplete,
      triage: triageResult
    });

  } catch (err) {
    console.warn("Live AI failed, using sandbox:", err.message);
    const auditResult = simulateAudit(title, description, []);
    session.currentAudit = auditResult;
    session.bestScores = {
      stepsScore: auditResult.stepsScore,
      envScore: auditResult.envScore,
      expectedActualScore: auditResult.expectedActualScore
    };
    const isComplete = auditResult.overallScore >= 80 || auditResult.clarifyingQuestions.length === 0;

    res.json({
      sessionId,
      mode: 'sandbox-simulation-fallback',
      scores: {
        stepsScore: auditResult.stepsScore,
        envScore: auditResult.envScore,
        expectedActualScore: auditResult.expectedActualScore,
        overallScore: auditResult.overallScore
      },
      reasoning: auditResult.reasoning + " (Fallback Mode)",
      nextQuestion: isComplete ? null : auditResult.clarifyingQuestions[0],
      isComplete,
      triage: null
    });
  }
});

// ─── POST /api/audit/message ──────────────────────────────────────────────────
app.post('/api/audit/message', async (req, res) => {
  const { sessionId, answer } = req.body;
  if (!sessionId || !answer) {
    return res.status(400).json({ error: "Session ID and answer are required." });
  }
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found." });

  session.history.push({ content: answer, timestamp: new Date().toISOString() });
  session.questionCount = (session.questionCount || 0) + 1;
  const forceComplete = session.questionCount >= 3;

  const historyText = session.history.map((h, i) => `Answer ${i + 1}: ${h.content}`).join('\n');

  try {
    let auditResult;

    if (isLiveMode()) {
      const systemPrompt = `You are an IT Service Desk AI Auditor. Re-evaluate using ALL info so far.

Score 0–5 for each:
- stepsScore, envScore, expectedActualScore
- overallScore = round((stepsScore/5)*35 + (envScore/5)*30 + (expectedActualScore/5)*35)

CRITICAL: Scores must NEVER decrease from previous round.
Previous scores — steps: ${session.bestScores?.stepsScore ?? 0}, env: ${session.bestScores?.envScore ?? 0}, expected/actual: ${session.bestScores?.expectedActualScore ?? 0}

Rules:
- Re-score based on ALL text combined.
- ${forceComplete ? 'FINAL ROUND: return clarifyingQuestions as [].' : 'Ask 1 specific new question for the biggest remaining gap, or [] if overallScore >= 80.'}
- Do NOT repeat anything already asked.

JSON only: {"stepsScore":number,"envScore":number,"expectedActualScore":number,"overallScore":number,"reasoning":"string","clarifyingQuestions":[]}`;

      auditResult = await callGroq(systemPrompt,
        `Title: ${session.title}\nDescription: ${session.originalDescription}\n\nUser Answers:\n${historyText}`);

      // Enforce no-decrease even with live AI
      auditResult.stepsScore          = Math.max(auditResult.stepsScore,          session.bestScores?.stepsScore ?? 0);
      auditResult.envScore            = Math.max(auditResult.envScore,            session.bestScores?.envScore ?? 0);
      auditResult.expectedActualScore = Math.max(auditResult.expectedActualScore, session.bestScores?.expectedActualScore ?? 0);
      auditResult.overallScore        = Math.round(
        (auditResult.stepsScore / 5) * 35 +
        (auditResult.envScore   / 5) * 30 +
        (auditResult.expectedActualScore / 5) * 35
      );
    } else {
      // Pass bestScores so sandbox also never decreases
      auditResult = simulateAudit(
        session.title,
        session.originalDescription,
        session.history,
        session.bestScores
      );
    }

    // Update best scores
    session.bestScores = {
      stepsScore:          Math.max(auditResult.stepsScore,          session.bestScores?.stepsScore ?? 0),
      envScore:            Math.max(auditResult.envScore,            session.bestScores?.envScore ?? 0),
      expectedActualScore: Math.max(auditResult.expectedActualScore, session.bestScores?.expectedActualScore ?? 0)
    };
    session.currentAudit = auditResult;

    const isComplete = forceComplete ||
                       auditResult.overallScore >= 80 ||
                       !auditResult.clarifyingQuestions ||
                       auditResult.clarifyingQuestions.length === 0;
    const nextQuestion = isComplete ? null : auditResult.clarifyingQuestions[0];

    let triageResult = null;
    if (isComplete) {
      session.status = 'assigned';
      triageResult = isLiveMode()
        ? await callGroq(
            `Route this ticket. ONE of: Frontend Team, Backend Team, Database Team, DevOps & Cloud Infrastructure, QA & Testing.
JSON only: {"assignedTo":"string","priority":"Low|Medium|High|Critical","summary":"string","justification":"string"}`,
            `Title: ${session.title}\nDescription: ${session.originalDescription}\nAnswers:\n${historyText}`)
        : simulateTriage(session.title, session.originalDescription, session.history);
      session.triage = triageResult;
    }

    res.json({
      sessionId,
      mode: isLiveMode() ? 'live-ai' : 'sandbox-simulation',
      scores: {
        stepsScore: auditResult.stepsScore,
        envScore: auditResult.envScore,
        expectedActualScore: auditResult.expectedActualScore,
        overallScore: auditResult.overallScore
      },
      reasoning: auditResult.reasoning,
      nextQuestion,
      isComplete,
      triage: triageResult
    });

  } catch (err) {
    console.warn("Fallback on message:", err.message);
    const auditResult = simulateAudit(session.title, session.originalDescription, session.history, session.bestScores);
    session.bestScores = {
      stepsScore:          Math.max(auditResult.stepsScore,          session.bestScores?.stepsScore ?? 0),
      envScore:            Math.max(auditResult.envScore,            session.bestScores?.envScore ?? 0),
      expectedActualScore: Math.max(auditResult.expectedActualScore, session.bestScores?.expectedActualScore ?? 0)
    };
    session.currentAudit = auditResult;

    const isComplete = forceComplete || auditResult.overallScore >= 80;
    let triageResult = null;
    if (isComplete) {
      session.status = 'assigned';
      triageResult = simulateTriage(session.title, session.originalDescription, session.history);
      session.triage = triageResult;
    }

    res.json({
      sessionId,
      mode: 'sandbox-simulation-fallback',
      scores: {
        stepsScore: auditResult.stepsScore,
        envScore: auditResult.envScore,
        expectedActualScore: auditResult.expectedActualScore,
        overallScore: auditResult.overallScore
      },
      reasoning: auditResult.reasoning + " (Fallback Mode)",
      nextQuestion: isComplete ? null : (auditResult.clarifyingQuestions[0] || null),
      isComplete,
      triage: triageResult
    });
  }
});

// ─── GET /api/sessions ────────────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [, sess] of sessions.entries()) {
    list.push({
      id: sess.id, title: sess.title,
      overallScore: sess.currentAudit ? sess.currentAudit.overallScore : 0,
      status: sess.status,
      assignedTo: sess.triage ? sess.triage.assignedTo : null,
      priority:   sess.triage ? sess.triage.priority   : null
    });
  }
  res.json(list);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 Ticket Quality Auditor (SD-13) — Port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`⚙️  Mode: ${isLiveMode() ? '🟢 Live AI (Groq llama-3.3-70b)' : '🟡 Sandbox Simulator'}`);
  console.log(`========================================================`);
});

module.exports = server;

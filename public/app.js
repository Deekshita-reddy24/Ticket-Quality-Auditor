let currentSessionId = null;
let currentMode = 'sandbox-simulation';
let auditHistoryList = [];

// Sample Tickets
const SAMPLE_TICKETS = [
  {
    title: "Login failure on user login page",
    description: "Whenever I try to log in, it does not work. Please check and fix."
  },
  {
    title: "PDF invoice generation failing",
    description: "I am trying to download my invoice. I click the 'Download PDF' button, the page hangs for 10 seconds, and then shows a white screen. I'm using Chrome 124 on a MacBook Pro running macOS Sonoma. The URL is https://app.example.com/billing."
  },
  {
    title: "SQL migration syntax error",
    description: "Steps to reproduce:\n1. Run migration command 'npm run db:migrate'.\n2. The process fails at step 04_add_user_roles.\n\nExpected: The migration should succeed and create the roles table.\nActual: Fails with code 42P01: relation 'users' does not exist.\n\nEnvironment: PostgreSQL 16 on Docker (Ubuntu 22.04 LTS)."
  }
];

let sampleIndex = 0;

// DOM Elements
const screenSubmit    = document.getElementById('screen-submit');
const screenAudit     = document.getElementById('screen-audit');
const screenAssignment= document.getElementById('screen-assignment');
const screenHistory   = document.getElementById('screen-history');

const navBtnNew       = document.getElementById('nav-btn-new');
const navBtnHistory   = document.getElementById('nav-btn-history');

const ticketForm      = document.getElementById('ticket-form');
const ticketTitleInput= document.getElementById('ticket-title');
const ticketDescInput = document.getElementById('ticket-desc');
const loadSampleBtn   = document.getElementById('load-sample-btn');

const gaugeProgress   = document.getElementById('gauge-progress');
const gaugeScoreValue = document.getElementById('gauge-score-value');
const metricValSteps  = document.getElementById('metric-val-steps');
const metricBarSteps  = document.getElementById('metric-bar-steps');
const metricValEnv    = document.getElementById('metric-val-env');
const metricBarEnv    = document.getElementById('metric-bar-env');
const metricValExp    = document.getElementById('metric-val-exp');
const metricBarExp    = document.getElementById('metric-bar-exp');
const auditorReasoning= document.getElementById('auditor-reasoning');
const missingBreakdown= document.getElementById('missing-breakdown');

const chatMessages    = document.getElementById('chat-messages');
const chatInputForm   = document.getElementById('chat-input-form');
const chatInputField  = document.getElementById('chat-input-field');

const triageTitle     = document.getElementById('triage-title');
const triagePriority  = document.getElementById('triage-priority');
const triageSummary   = document.getElementById('triage-summary');
const triageQueue     = document.getElementById('triage-queue');
const triageFinalScore= document.getElementById('triage-final-score');
const triageJustification = document.getElementById('triage-justification-text');
const btnTriageNew    = document.getElementById('btn-triage-new');

const historyTableBody= document.getElementById('history-table-body');
const historyEmpty    = document.getElementById('history-empty');
const statTotal       = document.getElementById('stat-total');
const statAvg         = document.getElementById('stat-avg');
const modeIndicator   = document.getElementById('mode-indicator');

// Init SVG gauge gradient
function initGaugeGradient() {
  const svg = document.querySelector('.gauge-svg');
  if (!svg.querySelector('defs')) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const linearGradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    linearGradient.setAttribute('id', 'gauge-gradient');
    linearGradient.setAttribute('x1', '0%'); linearGradient.setAttribute('y1', '0%');
    linearGradient.setAttribute('x2', '100%'); linearGradient.setAttribute('y2', '100%');
    const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#5b8dd9');
    const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#7ea8e0');
    linearGradient.appendChild(stop1); linearGradient.appendChild(stop2);
    defs.appendChild(linearGradient); svg.insertBefore(defs, svg.firstChild);
  }
  gaugeProgress.setAttribute('stroke', 'url(#gauge-gradient)');
}

function showScreen(screen) {
  [screenSubmit, screenAudit, screenAssignment, screenHistory].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

function setActiveNav(activeBtn) {
  [navBtnNew, navBtnHistory].forEach(btn => btn.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
}

function getFormattedTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function updateScoreGauge(score) {
  const maxCircumference = 314.16;
  const offset = maxCircumference - (score / 100) * maxCircumference;
  gaugeProgress.style.strokeDashoffset = offset;

  let currentVal = parseInt(gaugeScoreValue.textContent) || 0;
  const duration = 800;
  const startTime = performance.now();

  function animateCount(timestamp) {
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    gaugeScoreValue.textContent = `${Math.round(currentVal + (score - currentVal) * eased)}%`;
    if (progress < 1) requestAnimationFrame(animateCount);
    else gaugeScoreValue.textContent = `${score}%`;
  }
  requestAnimationFrame(animateCount);
}

// ── What's Missing Panel ──────────────────────────────────────────────────────
function updateMissingPanel(scores) {
  const { stepsScore, envScore, expectedActualScore, overallScore } = scores;

  // If perfect score
  if (overallScore >= 100) {
    missingBreakdown.innerHTML = `
      <div class="missing-all-good">
        <i class="fa-solid fa-circle-check"></i>
        Ticket is fully complete — all details are present!
      </div>`;
    return;
  }

  // Define what each score level means per dimension
  const dimensions = [
    {
      label: 'Steps to Reproduce',
      icon: 'fa-list-ol',
      score: stepsScore,
      weight: '35%',
      missing: getMissingSteps(stepsScore),
      present: getPresentSteps(stepsScore)
    },
    {
      label: 'Environment Details',
      icon: 'fa-laptop',
      score: envScore,
      weight: '30%',
      missing: getMissingEnv(envScore),
      present: getPresentEnv(envScore)
    },
    {
      label: 'Expected vs Actual',
      icon: 'fa-code-compare',
      score: expectedActualScore,
      weight: '35%',
      missing: getMissingExpected(expectedActualScore),
      present: getPresentExpected(expectedActualScore)
    }
  ];

  // Calculate points lost per dimension
  const pointsLost = [
    Math.round(((5 - stepsScore) / 5) * 35),
    Math.round(((5 - envScore) / 5) * 30),
    Math.round(((5 - expectedActualScore) / 5) * 35)
  ];

  let html = '';

  dimensions.forEach((dim, i) => {
    const lost = pointsLost[i];
    const status = dim.score >= 4 ? 'ok' : dim.score >= 2 ? 'partial' : 'missing';
    const statusIcon = status === 'ok' ? 'fa-circle-check' : status === 'partial' ? 'fa-circle-half-stroke' : 'fa-circle-xmark';
    const statusLabel = status === 'ok' ? '✓ Good' : status === 'partial' ? `−${lost}pts` : `−${lost}pts`;

    html += `
      <div class="missing-dimension status-${status}">
        <div class="missing-dimension-header">
          <span class="dim-label">
            <i class="fa-solid ${statusIcon}"></i>
            <i class="fa-solid ${dim.icon}"></i>
            ${dim.label}
          </span>
          <span class="dim-score">${dim.score}/5 · ${statusLabel}</span>
        </div>`;

    // Show what's missing or what's present
    if (status !== 'ok' && dim.missing.length > 0) {
      html += `<div class="missing-items">`;
      dim.present.forEach(item => {
        html += `<div class="missing-item item-ok"><i class="fa-solid fa-check"></i><span>${item}</span></div>`;
      });
      dim.missing.forEach(item => {
        html += `<div class="missing-item item-missing"><i class="fa-solid fa-xmark"></i><span>${item}</span></div>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
  });

  // Summary line
  const totalLost = 100 - overallScore;
  if (totalLost > 0) {
    html += `
      <div style="margin-top:4px; padding: 8px 12px; border-radius:6px; background:rgba(255,255,255,0.02); border:1px solid var(--border-color); font-size:12px; color:var(--text-muted);">
        <i class="fa-solid fa-info-circle" style="color:var(--primary);margin-right:6px;"></i>
        Answering the agent's questions will fill the missing ${totalLost}% and improve your score.
      </div>`;
  }

  missingBreakdown.innerHTML = html;
}

function getMissingSteps(score) {
  if (score >= 5) return [];
  if (score >= 4) return ['More specific step details would help'];
  if (score >= 3) return ['Exact numbered steps (1, 2, 3...) not provided', 'Unclear which specific action triggers the issue'];
  if (score >= 2) return ['No numbered steps provided', 'Missing sequence of actions leading to the issue', 'Unclear starting point'];
  if (score >= 1) return ['No clear steps provided', 'No numbered sequence', 'Missing which buttons/pages were involved'];
  return ['No reproduction steps provided at all', 'Cannot replicate the issue without steps', 'What did you click? What page were you on?'];
}

function getPresentSteps(score) {
  if (score >= 4) return ['Numbered steps provided', 'Clear action sequence present'];
  if (score >= 3) return ['Some action words present', 'Partial sequence described'];
  if (score >= 2) return ['Some actions mentioned'];
  if (score >= 1) return ['Issue location vaguely mentioned'];
  return [];
}

function getMissingEnv(score) {
  if (score >= 5) return [];
  if (score >= 4) return ['Version number or device type could be more specific'];
  if (score >= 3) return ['Missing version numbers (e.g. Chrome 121, Windows 11)'];
  if (score >= 2) return ['Missing operating system (Windows/Mac/Linux)', 'Missing version numbers'];
  if (score >= 1) return ['Missing browser name', 'Missing operating system', 'Missing version numbers', 'Missing device type'];
  return ['No environment info provided at all', 'Which browser are you using?', 'Which operating system? (Windows/Mac/Linux/iOS/Android)', 'What version of the app?'];
}

function getPresentEnv(score) {
  if (score >= 4) return ['Browser identified', 'Operating system mentioned'];
  if (score >= 3) return ['Some environment info present'];
  if (score >= 2) return ['Browser or OS partially mentioned'];
  if (score >= 1) return ['Device type vaguely mentioned'];
  return [];
}

function getMissingExpected(score) {
  if (score >= 5) return [];
  if (score >= 4) return ['Could be more explicit about the expected outcome'];
  if (score >= 3) return ['Missing what the user actually expected to happen'];
  if (score >= 2) return ['No clear "expected" behavior stated', 'Actual result not clearly separated from description'];
  if (score >= 1) return ['No expected behavior described', 'No actual result described', 'Missing error messages or codes'];
  return ['No expected vs actual behavior provided at all', 'What should have happened?', 'What actually happened instead?', 'Were there any error messages?'];
}

function getPresentExpected(score) {
  if (score >= 4) return ['Expected behavior described', 'Actual behavior described'];
  if (score >= 3) return ['Some outcome description present'];
  if (score >= 2) return ['Error or failure vaguely mentioned'];
  if (score >= 1) return ['Issue outcome partially described'];
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────

function updateAuditDashboard(scores, reasoning) {
  metricValSteps.textContent = `${scores.stepsScore}/5`;
  metricValEnv.textContent   = `${scores.envScore}/5`;
  metricValExp.textContent   = `${scores.expectedActualScore}/5`;

  metricBarSteps.style.width = `${(scores.stepsScore / 5) * 100}%`;
  metricBarEnv.style.width   = `${(scores.envScore / 5) * 100}%`;
  metricBarExp.style.width   = `${(scores.expectedActualScore / 5) * 100}%`;

  updateScoreGauge(scores.overallScore);
  auditorReasoning.textContent = reasoning;

  // Update the missing panel
  updateMissingPanel(scores);
}

function appendMessage(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${sender === 'user' ? 'sent' : 'received'}`;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = getFormattedTime();
  msgDiv.appendChild(bubble);
  msgDiv.appendChild(time);
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTypingIndicator() {
  const typingDiv = document.createElement('div');
  typingDiv.className = 'message received typing-container';
  typingDiv.id = 'agent-typing';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(indicator);
  typingDiv.appendChild(bubble);
  chatMessages.appendChild(typingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  const typingDiv = document.getElementById('agent-typing');
  if (typingDiv) typingDiv.remove();
}

function updateModeBadge(mode) {
  currentMode = mode;
  modeIndicator.className = 'badge';
  if (mode === 'live-ai') {
    modeIndicator.classList.add('live-badge');
    modeIndicator.innerHTML = '<i class="fa-solid fa-brain"></i> Live AI Mode';
  } else {
    modeIndicator.classList.add('sandbox-badge');
    modeIndicator.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> Sandbox Mode';
  }
}

async function startAudit(title, description) {
  showScreen(screenAudit);
  chatMessages.innerHTML = '';
  // Reset missing panel
  missingBreakdown.innerHTML = '<div class="missing-loading"><i class="fa-solid fa-spinner fa-spin"></i> Analyzing ticket...</div>';
  showTypingIndicator();

  try {
    const response = await fetch('/api/audit/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    currentSessionId = data.sessionId;
    updateModeBadge(data.mode);
    removeTypingIndicator();

    appendMessage('agent', `Hello! I have started auditing your ticket: "${title}". Let me score its initial completeness.`);
    updateAuditDashboard(data.scores, data.reasoning);

    if (data.isComplete) {
      setTimeout(() => renderTriageAssignment(data), 1500);
    } else if (data.nextQuestion) {
      setTimeout(() => appendMessage('agent', data.nextQuestion), 600);
    }
  } catch (error) {
    removeTypingIndicator();
    appendMessage('agent', `Failed to audit ticket. Connection issue: ${error.message}`);
  }
}

async function sendClarifyingAnswer(answer) {
  appendMessage('user', answer);
  chatInputField.value = '';
  showTypingIndicator();

  try {
    const response = await fetch('/api/audit/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, answer })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);

    removeTypingIndicator();
    updateAuditDashboard(data.scores, data.reasoning);

    if (data.isComplete) {
      appendMessage('agent', "Thank you! The ticket is now complete. Finalizing assignment...");
      setTimeout(() => renderTriageAssignment(data), 1200);
    } else if (data.nextQuestion) {
      appendMessage('agent', data.nextQuestion);
    }
  } catch (error) {
    removeTypingIndicator();
    appendMessage('agent', `Failed to send response: ${error.message}`);
  }
}

function renderTriageAssignment(data) {
  const triage = data.triage;
  if (!triage) return;

  triageTitle.textContent = ticketTitleInput.value;
  triagePriority.textContent = `${triage.priority} Priority`;
  triagePriority.className = 'badge badge-priority';
  triagePriority.classList.add(triage.priority.toLowerCase());

  triageSummary.textContent = triage.summary;
  triageQueue.textContent = triage.assignedTo;
  triageFinalScore.textContent = `${data.scores.overallScore}%`;
  triageJustification.textContent = triage.justification;

  showScreen(screenAssignment);
  updateStatsAndHistory();
}

async function updateStatsAndHistory() {
  try {
    const response = await fetch('/api/sessions');
    const sessions = await response.json();

    statTotal.textContent = sessions.length;
    if (sessions.length > 0) {
      const sum = sessions.reduce((acc, s) => acc + s.overallScore, 0);
      statAvg.textContent = `${Math.round(sum / sessions.length)}%`;
      historyEmpty.style.display = 'none';
    } else {
      statAvg.textContent = '0%';
      historyEmpty.style.display = 'flex';
    }

    historyTableBody.innerHTML = '';
    sessions.reverse().forEach(sess => {
      const row = document.createElement('tr');
      const statusBadge = sess.status === 'assigned'
        ? `<span class="badge" style="background-color: rgba(76,175,130,0.12); color: var(--success);"><i class="fa-solid fa-circle-check"></i> Assigned</span>`
        : `<span class="badge" style="background-color: rgba(212,146,74,0.12); color: var(--warning);"><i class="fa-solid fa-spinner"></i> In Progress</span>`;

      const priorityClass = sess.priority ? sess.priority.toLowerCase() : 'low';
      row.innerHTML = `
        <td style="font-family:monospace;font-size:12px;color:var(--text-secondary);">${sess.id}</td>
        <td style="font-weight:500;">${sess.title}</td>
        <td style="font-weight:700;color:var(--primary);">${sess.overallScore}%</td>
        <td>${statusBadge}</td>
        <td style="font-weight:600;">${sess.assignedTo || '-'}</td>
        <td>${sess.priority ? `<span class="badge badge-priority ${priorityClass}">${sess.priority}</span>` : '-'}</td>
      `;
      historyTableBody.appendChild(row);
    });
  } catch (error) {
    console.error("Error loading session history:", error);
  }
}

function setupEvents() {
  navBtnNew.addEventListener('click', () => {
    setActiveNav(navBtnNew);
    showScreen(screenSubmit);
  });

  navBtnHistory.addEventListener('click', () => {
    setActiveNav(navBtnHistory);
    showScreen(screenHistory);
    updateStatsAndHistory();
  });

  ticketForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = ticketTitleInput.value.trim();
    const desc  = ticketDescInput.value.trim();
    if (title && desc) startAudit(title, desc);
  });

  chatInputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const answer = chatInputField.value.trim();
    if (answer && currentSessionId) sendClarifyingAnswer(answer);
  });

  loadSampleBtn.addEventListener('click', () => {
    const ticket = SAMPLE_TICKETS[sampleIndex];
    ticketTitleInput.value = ticket.title;
    ticketDescInput.value  = ticket.description;
    sampleIndex = (sampleIndex + 1) % SAMPLE_TICKETS.length;
  });

  btnTriageNew.addEventListener('click', () => {
    ticketForm.reset();
    setActiveNav(navBtnNew);
    showScreen(screenSubmit);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initGaugeGradient();
  setupEvents();
  updateStatsAndHistory();
});

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from pathlib import Path
from groq import Groq
import json
import os

load_dotenv()

app = FastAPI(title="AI Ticket Quality Auditor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# In-memory session store
sessions: dict = {}

# ─── Models ───────────────────────────────────────────────────────────────────

class StartAuditRequest(BaseModel):
    title: str
    description: str

class MessageRequest(BaseModel):
    sessionId: str
    answer: str

# ─── Helpers ──────────────────────────────────────────────────────────────────

def is_live_mode() -> bool:
    key = os.getenv("GROQ_API_KEY", "")
    return bool(key and key != "GROQ_API_KEY")


def call_groq(system_prompt: str, user_prompt: str) -> dict:
    completion = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt}
        ],
        temperature=0.3,
        response_format={"type": "json_object"}
    )
    text = completion.choices[0].message.content or "{}"
    return json.loads(text)


# ─── Sandbox Fallback ─────────────────────────────────────────────────────────

def score_steps(text: str) -> int:
    t = text.lower()
    action_words = ["click","open","go","navigate","login","select","enter","submit",
                    "press","type","access","upload","download","run","tap","refresh"]
    action_count = sum(1 for w in action_words if w in t)
    numbered = len([m for m in __import__("re").findall(r"\b\d+[\.\)]\s+\w", t)])
    sequence = any(w in t for w in ["first","then","after","next","finally","step"])
    if numbered >= 3: return 5
    if numbered == 2: return 4
    if numbered == 1 or (sequence and action_count >= 2): return 3
    if action_count >= 2: return 2
    if action_count >= 1 or sequence: return 1
    return 0

def score_env(text: str) -> int:
    t = text.lower()
    browsers = ["chrome","firefox","safari","edge","opera","brave"]
    oses     = ["windows","mac","macos","linux","ubuntu","android","ios","iphone","ipad"]
    devices  = ["mobile","desktop","laptop","tablet","phone","pc"]
    import re
    versions = re.findall(r"v?\d+(\.\d+)+", t)
    has_browser  = any(b in t for b in browsers)
    has_os       = any(o in t for o in oses)
    has_device   = any(d in t for d in devices)
    has_version  = bool(versions) or any(v in t for v in ["version","latest"])
    score = 0
    if has_browser or has_os: score = max(score, 2)
    if has_browser and has_os: score = max(score, 4)
    if (has_browser or has_os) and (has_version or has_device): score = max(score, 5)
    if score == 0 and (has_browser or has_os or has_device or has_version): score = 1
    return score

def score_expected_actual(text: str) -> int:
    t = text.lower()
    expect_words = ["expect","should","supposed to","meant to"]
    actual_words = ["actual","instead","however","doesn't","can't","unable","fail",
                    "failed","error","broken","wrong","not working","blank","missing","crash"]
    import re
    error_codes = re.findall(r"\b(404|500|403|401|503|4\d\d|5\d\d)\b", t)
    has_expect = any(w in t for w in expect_words)
    has_actual = any(w in t for w in actual_words)
    has_error  = bool(error_codes)
    if has_expect and has_actual: return 5
    if has_expect and (has_error or len(text) > 80): return 4
    if has_actual and has_error: return 3
    if has_expect or (has_actual and len(text) > 60): return 3
    if has_actual or has_error: return 2
    if len(text.strip()) > 20: return 1
    return 0

def simulate_audit(title: str, description: str, history: list, prev_scores: dict = None) -> dict:
    all_text = " ".join([title, description] + [h["content"] for h in history])

    steps_score          = score_steps(all_text)
    env_score            = score_env(all_text)
    expected_actual_score = score_expected_actual(all_text)

    # Title bonus
    if len(title.strip().split()) >= 5:
        steps_score           = min(steps_score + 1, 5)
        expected_actual_score = min(expected_actual_score + 1, 5)

    # Anti-decrease
    if prev_scores:
        steps_score           = max(steps_score,           prev_scores.get("stepsScore", 0))
        env_score             = max(env_score,             prev_scores.get("envScore", 0))
        expected_actual_score = max(expected_actual_score, prev_scores.get("expectedActualScore", 0))

    overall_score = round((steps_score / 5) * 35 + (env_score / 5) * 30 + (expected_actual_score / 5) * 35)

    # Generate 1 clarifying question for the weakest dimension
    clarifying_questions = []
    title_lower = title.lower()

    if steps_score < 3:
        if any(w in title_lower for w in ["login","auth","sign"]):
            clarifying_questions.append("What exact steps did you follow to log in, and at which step does the issue appear?")
        elif any(w in title_lower for w in ["payment","checkout","billing"]):
            clarifying_questions.append("Which payment method were you using and at which step did it fail?")
        elif any(w in title_lower for w in ["pdf","download","export"]):
            clarifying_questions.append("What steps did you take before clicking download, and what happened after?")
        elif any(w in title_lower for w in ["database","sql","migration"]):
            clarifying_questions.append("What exact command triggered the error, and what was the full error message?")
        else:
            clarifying_questions.append("Can you walk us through the exact steps that led to this issue?")
    elif env_score < 3:
        clarifying_questions.append("Which browser and operating system are you using? (e.g. Chrome 121 on Windows 11)")
    elif expected_actual_score < 3:
        clarifying_questions.append("What did you expect to happen, and what actually occurred instead?")

    missing = []
    if steps_score < 3: missing.append("reproduction steps")
    if env_score < 3: missing.append("environment info")
    if expected_actual_score < 3: missing.append("expected vs actual behavior")

    if overall_score >= 80:
        reasoning = "Ticket is well-documented. Ready to assign."
    else:
        reasoning = f"Steps: {steps_score}/5 · Environment: {env_score}/5 · Expected/Actual: {expected_actual_score}/5."
        if missing:
            reasoning += f" Missing: {', '.join(missing)}."

    return {
        "stepsScore": steps_score,
        "envScore": env_score,
        "expectedActualScore": expected_actual_score,
        "overallScore": overall_score,
        "reasoning": reasoning,
        "clarifyingQuestions": clarifying_questions
    }


def simulate_triage(title: str, description: str, history: list) -> dict:
    full_text = " ".join([title, description] + [h["content"] for h in history]).lower()

    assigned_to   = "Backend Team"
    priority      = "Medium"
    summary       = f"Issue reported: {title}"
    justification = "Relates to general server-side or API behavior."

    if any(w in full_text for w in ["css","layout","ui","button","menu","align","style","frontend"]):
        assigned_to   = "Frontend Team"
        justification = "Involves UI, styling, or client-side rendering."
    elif any(w in full_text for w in ["database","sql","migration","schema","query","mongo","postgres"]):
        assigned_to   = "Database Team"
        justification = "Involves database queries, schema, or migrations."
    elif any(w in full_text for w in ["deploy","docker","aws","cloud","devops","pipeline"]):
        assigned_to   = "DevOps & Cloud Infrastructure"
        justification = "Relates to infrastructure or deployment."
    elif any(w in full_text for w in ["test","qa","regression","flaky","unit"]):
        assigned_to   = "QA & Testing"
        justification = "Requires testing and quality assurance review."

    if any(w in full_text for w in ["crash","timeout","fail","error","critical"]):
        priority = "High"
    if any(w in full_text for w in ["production","down","blocking","urgent","outage"]):
        priority = "Critical"
    if any(w in full_text for w in ["minor","cosmetic","typo","small","low"]):
        priority = "Low"

    return {"assignedTo": assigned_to, "priority": priority, "summary": summary, "justification": justification}


# ─── POST /api/audit/start ────────────────────────────────────────────────────

@app.post("/api/audit/start")
async def audit_start(req: StartAuditRequest):
    if not req.title or not req.description:
        return {"error": "Title and description are required."}

    session_id = f"session_{__import__('time').time_ns()}"
    session = {
        "id": session_id,
        "title": req.title,
        "originalDescription": req.description,
        "history": [],
        "currentAudit": None,
        "questionCount": 0,
        "status": "active",
        "triage": None,
        "bestScores": None
    }
    sessions[session_id] = session

    try:
        if is_live_mode():
            system_prompt = """You are an expert IT Service Desk AI Auditor. Score this ticket's completeness.

Score these 3 dimensions (each 0-5):
- stepsScore: clear numbered reproduction steps
- envScore: OS, browser, version, device info
- expectedActualScore: what user expected vs what actually happened

overallScore = round((stepsScore/5)*35 + (envScore/5)*30 + (expectedActualScore/5)*35)

Rules:
- Generate exactly 1 clarifying question for the SINGLE most important missing detail — specific to this ticket.
- Do NOT ask for info already in the ticket.
- If overallScore >= 80, return clarifyingQuestions as [].

JSON only — no markdown:
{"stepsScore":0,"envScore":0,"expectedActualScore":0,"overallScore":0,"reasoning":"string","clarifyingQuestions":["one question"]}"""

            audit_result = call_groq(system_prompt, f"Title: {req.title}\nDescription: {req.description}")
        else:
            audit_result = simulate_audit(req.title, req.description, [])

        session["currentAudit"] = audit_result
        session["bestScores"] = {
            "stepsScore": audit_result["stepsScore"],
            "envScore": audit_result["envScore"],
            "expectedActualScore": audit_result["expectedActualScore"]
        }

        questions = audit_result.get("clarifyingQuestions", [])
        is_complete = audit_result["overallScore"] >= 80 or len(questions) == 0
        next_question = None if is_complete else questions[0]

        triage_result = None
        if is_complete:
            session["status"] = "assigned"
            if is_live_mode():
                triage_result = call_groq(
                    """Route this ticket. Pick ONE: Frontend Team, Backend Team, Database Team, DevOps & Cloud Infrastructure, QA & Testing.
JSON only: {"assignedTo":"string","priority":"Low|Medium|High|Critical","summary":"one sentence","justification":"reason"}""",
                    f"Title: {req.title}\nDescription: {req.description}"
                )
            else:
                triage_result = simulate_triage(req.title, req.description, [])
            session["triage"] = triage_result

        return {
            "sessionId": session_id,
            "mode": "live-ai" if is_live_mode() else "sandbox-simulation",
            "scores": {
                "stepsScore": audit_result["stepsScore"],
                "envScore": audit_result["envScore"],
                "expectedActualScore": audit_result["expectedActualScore"],
                "overallScore": audit_result["overallScore"]
            },
            "reasoning": audit_result["reasoning"],
            "nextQuestion": next_question,
            "isComplete": is_complete,
            "triage": triage_result
        }

    except Exception as e:
        print(f"Live AI failed, using sandbox: {e}")
        audit_result = simulate_audit(req.title, req.description, [])
        session["currentAudit"] = audit_result
        session["bestScores"] = {
            "stepsScore": audit_result["stepsScore"],
            "envScore": audit_result["envScore"],
            "expectedActualScore": audit_result["expectedActualScore"]
        }
        questions = audit_result.get("clarifyingQuestions", [])
        is_complete = audit_result["overallScore"] >= 80 or len(questions) == 0

        return {
            "sessionId": session_id,
            "mode": "sandbox-simulation-fallback",
            "scores": {
                "stepsScore": audit_result["stepsScore"],
                "envScore": audit_result["envScore"],
                "expectedActualScore": audit_result["expectedActualScore"],
                "overallScore": audit_result["overallScore"]
            },
            "reasoning": audit_result["reasoning"] + " (Fallback Mode)",
            "nextQuestion": None if is_complete else questions[0],
            "isComplete": is_complete,
            "triage": None
        }


# ─── POST /api/audit/message ──────────────────────────────────────────────────

@app.post("/api/audit/message")
async def audit_message(req: MessageRequest):
    if not req.sessionId or not req.answer:
        return {"error": "Session ID and answer are required."}

    session = sessions.get(req.sessionId)
    if not session:
        return {"error": "Session not found."}

    session["history"].append({"content": req.answer, "timestamp": __import__("datetime").datetime.now().isoformat()})
    session["questionCount"] = session.get("questionCount", 0) + 1
    force_complete = session["questionCount"] >= 3

    history_text = "\n".join([f"Answer {i+1}: {h['content']}" for i, h in enumerate(session["history"])])
    best = session.get("bestScores") or {}

    try:
        if is_live_mode():
            system_prompt = f"""You are an IT Service Desk AI Auditor. Re-evaluate using ALL info so far.

Score 0-5 for each: stepsScore, envScore, expectedActualScore
overallScore = round((stepsScore/5)*35 + (envScore/5)*30 + (expectedActualScore/5)*35)

CRITICAL: Scores must NEVER decrease.
Previous scores — steps: {best.get('stepsScore',0)}, env: {best.get('envScore',0)}, expected/actual: {best.get('expectedActualScore',0)}

{"FINAL ROUND: return clarifyingQuestions as []." if force_complete else "Ask 1 specific new question for the biggest remaining gap, or [] if overallScore >= 80."}
Do NOT repeat anything already asked.

JSON only: {{"stepsScore":0,"envScore":0,"expectedActualScore":0,"overallScore":0,"reasoning":"string","clarifyingQuestions":[]}}"""

            audit_result = call_groq(
                system_prompt,
                f"Title: {session['title']}\nDescription: {session['originalDescription']}\n\nUser Answers:\n{history_text}"
            )

            # Enforce no-decrease
            audit_result["stepsScore"]          = max(audit_result["stepsScore"],          best.get("stepsScore", 0))
            audit_result["envScore"]            = max(audit_result["envScore"],            best.get("envScore", 0))
            audit_result["expectedActualScore"] = max(audit_result["expectedActualScore"], best.get("expectedActualScore", 0))
            audit_result["overallScore"]        = round(
                (audit_result["stepsScore"] / 5) * 35 +
                (audit_result["envScore"]   / 5) * 30 +
                (audit_result["expectedActualScore"] / 5) * 35
            )
        else:
            audit_result = simulate_audit(
                session["title"],
                session["originalDescription"],
                session["history"],
                session.get("bestScores")
            )

        # Update best scores
        session["bestScores"] = {
            "stepsScore":          max(audit_result["stepsScore"],          best.get("stepsScore", 0)),
            "envScore":            max(audit_result["envScore"],            best.get("envScore", 0)),
            "expectedActualScore": max(audit_result["expectedActualScore"], best.get("expectedActualScore", 0))
        }
        session["currentAudit"] = audit_result

        questions    = audit_result.get("clarifyingQuestions", [])
        is_complete  = force_complete or audit_result["overallScore"] >= 80 or len(questions) == 0
        next_question = None if is_complete else questions[0]

        triage_result = None
        if is_complete:
            session["status"] = "assigned"
            if is_live_mode():
                triage_result = call_groq(
                    """Route this ticket. ONE of: Frontend Team, Backend Team, Database Team, DevOps & Cloud Infrastructure, QA & Testing.
JSON only: {"assignedTo":"string","priority":"Low|Medium|High|Critical","summary":"string","justification":"string"}""",
                    f"Title: {session['title']}\nDescription: {session['originalDescription']}\nAnswers:\n{history_text}"
                )
            else:
                triage_result = simulate_triage(session["title"], session["originalDescription"], session["history"])
            session["triage"] = triage_result

        return {
            "sessionId": req.sessionId,
            "mode": "live-ai" if is_live_mode() else "sandbox-simulation",
            "scores": {
                "stepsScore": audit_result["stepsScore"],
                "envScore": audit_result["envScore"],
                "expectedActualScore": audit_result["expectedActualScore"],
                "overallScore": audit_result["overallScore"]
            },
            "reasoning": audit_result["reasoning"],
            "nextQuestion": next_question,
            "isComplete": is_complete,
            "triage": triage_result
        }

    except Exception as e:
        print(f"Fallback on message: {e}")
        audit_result = simulate_audit(session["title"], session["originalDescription"], session["history"], session.get("bestScores"))
        session["bestScores"] = {
            "stepsScore":          max(audit_result["stepsScore"],          best.get("stepsScore", 0)),
            "envScore":            max(audit_result["envScore"],            best.get("envScore", 0)),
            "expectedActualScore": max(audit_result["expectedActualScore"], best.get("expectedActualScore", 0))
        }
        session["currentAudit"] = audit_result

        is_complete = force_complete or audit_result["overallScore"] >= 80
        triage_result = None
        if is_complete:
            session["status"] = "assigned"
            triage_result = simulate_triage(session["title"], session["originalDescription"], session["history"])
            session["triage"] = triage_result

        questions = audit_result.get("clarifyingQuestions", [])
        return {
            "sessionId": req.sessionId,
            "mode": "sandbox-simulation-fallback",
            "scores": {
                "stepsScore": audit_result["stepsScore"],
                "envScore": audit_result["envScore"],
                "expectedActualScore": audit_result["expectedActualScore"],
                "overallScore": audit_result["overallScore"]
            },
            "reasoning": audit_result["reasoning"] + " (Fallback Mode)",
            "nextQuestion": None if is_complete else (questions[0] if questions else None),
            "isComplete": is_complete,
            "triage": triage_result
        }


# ─── GET /api/sessions ────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def get_sessions():
    return [
        {
            "id": s["id"],
            "title": s["title"],
            "overallScore": s["currentAudit"]["overallScore"] if s["currentAudit"] else 0,
            "status": s["status"],
            "assignedTo": s["triage"]["assignedTo"] if s["triage"] else None,
            "priority":   s["triage"]["priority"]   if s["triage"] else None
        }
        for s in sessions.values()
    ]


@app.get("/health")
async def health():
    return {"status": "ok", "mode": "live-ai" if is_live_mode() else "sandbox"}


# ─── Serve Frontend ────────────────────────────────────────────────────────────

frontend_dir = Path(__file__).parent / "public"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

    @app.get("/")
    async def serve_frontend():
        return FileResponse(str(frontend_dir / "index.html"))


# AuditAI - Ticket Quality Auditor (SD-13)

A working prototype for **SD-13: Ticket Quality Auditor**, developed for the Campus AI Prototype Challenge. This system intercepts vague "It's broken!" tickets, audits their quality, gathers clarifying info using an agent conversation loop, and automatically routes them to the correct engineering queue once complete.

## 🎥 Project Demo Video

[▶️ Watch the Demo Video](https://www.loom.com/share/d2a443aad90c466e92ec912a6043531c)

## 🌟 Key Features

1. **Intelligent Ticket Completeness Scoring**: Evaluates submissions out of 5 across three critical axes:
   - Steps to Reproduce
   - Environment details (Browser, OS, versions)
   - Expected vs Actual behavior
2. **Interactive Agent Loop**: Asks up to 3 context-aware clarifying questions to gather missing information. Dynamic re-scoring is performed as the user replies.
3. **Automated Triage & Routing**: Once the quality threshold (85%+) is satisfied, it summarizes and assigns the ticket to the appropriate queue (Frontend, Backend, Database, DevOps, QA).
4. **Dual-Mode LLM Engine**: Runs using the **Groq** (with a `GROQ_API_KEY`), but automatically defaults to a sandbox mock agent when offline or without a key.

---
```
## 📁 Repository Structure

# Ticket-Quality-Auditor
.
├── project-files/
│   ├── assets/                 # Project screenshots and media
│   │   ├── ai-audit-feedback.png
│   │   ├── submission-interface.png
│   │   ├── triage-history.png
│   │   └── successful-triage.png
│   ├── data/                   # Project datasets
│   │   ├── expected_scores.json
│   │   └── sample_tickets.json
│   ├── public/                 # Static front-end resources
│   │   ├── app.js
│   │   ├── index.html
│   │   └── style.css
│   ├── tests/
│   ├── main.py
│   ├── package-lock.json
│   ├── package.json
│   ├── requirements.txt
│   └── server.js
├── team-info/
├── .gitignore
├── prompts_used.md
── ai_usage_note.md
└── README.md

---

## 🛠️ Installation & Setup

Make sure you have [Node.js](https://nodejs.org/) installed (v18 or higher is recommended).

1. **Clone or Extract the folder**:
   Navigate into the project directory:
   ```bash
   cd ticket-quality-auditor
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   copy .env.example .env
   ```
   *Note: To run in live AI mode, obtain a Gemini API key and add it to the `.env` file (`GEMINI_API_KEY=AIzaSy...`). If left empty, the application will automatically run in the interactive offline **Sandbox Mode**.*

4. **Run the Server**:
   ```bash
   npm start
   ```
   The server will start, and the local URL will be printed in the console:
   ```text
   🚀 Ticket Quality Auditor (SD-13) running on Port 3000
   🌐 Local UI URL: http://localhost:3000
   ```

5. **Access the Web Interface**:
   Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🧪 Running Tests

Verify the endpoint flow and mock engine scoring using Jest:
```bash
npm test
```
The test suite validates:
- Initialization of incomplete tickets.
- Score increments upon receiving answers.
- Conversion to completed triage status.
- Listing active sessions.

---

## 💡 Engineering Assumptions & Limitations
- **State management**: Session data is held in-memory. Restarting the server resets active sessions. For production, integrate Redis or PostgreSQL.
- **Agent Limit**: To respect users' time, the auditor asks a maximum of 3 clarifying questions before automatically assigning the ticket based on available information.



## 👥 Team Information

**Team ID:** 8  
**Problem Statement ID:** SD-13  
**Institution:** Ashoka Women's Engineering College  

**Team Members & Contributions:**

- Deekshita Reddy Kancharla – Backend Development & Integration  
- G.K. Sneha Deepika – Frontend Development & UI Design  
- S. Vishnu Sireesha – AI Integration & Testing  
- Shahnaz Bhanu – Documentation & Project Support



## Team Resumes
You can view the resumes of our project team members here:
* **Deekshita Reddy** - [View Resume](./resumes/Deekshita%20Reddy%20...pdf)
* **GK Sneha Deepika** - [View Resume](./resumes/GK_Sneha_Deepika_Resume.pdf)
* **S. Vishnu Sireesha** - [View Resume](./resumes/S.Vishnu%20Sireesha.pdf)
* **Shahanaz Banu** - [View Resume](./resumes/shahanaz%20banu.tmp.pdf)

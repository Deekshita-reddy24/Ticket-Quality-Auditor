const request = require('supertest');
const server = require('../server');

describe('Ticket Quality Auditor (SD-13) API Tests', () => {
  jest.setTimeout(25000);
  let sessionId;

  // Cleanup after all tests
  afterAll((done) => {
    server.close(done);
  });

  test('POST /api/audit/start - Start audit for incomplete ticket', async () => {
    const res = await request(server)
      .post('/api/audit/start')
      .send({
        title: "Database connection failed",
        description: "I am trying to run the system and it says database connection failure. Help!"
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('sessionId');
    expect(res.body).toHaveProperty('scores');
    expect(res.body).toHaveProperty('nextQuestion');
    expect(res.body).toHaveProperty('isComplete');

    sessionId = res.body.sessionId;
    
    // An incomplete ticket should not be marked complete immediately
    expect(res.body.isComplete).toBe(false);
    expect(res.body.scores.overallScore).toBeLessThan(80);
    expect(res.body.nextQuestion).not.toBeNull();
  });

  test('POST /api/audit/message - Provide clarification answers', async () => {
    expect(sessionId).toBeDefined();

    // Answer 1: steps
    const res = await request(server)
      .post('/api/audit/message')
      .send({
        sessionId: sessionId,
        answer: "Here are the steps to reproduce: 1. Turn on database. 2. Run npm run start command."
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('scores');
  });

  test('POST /api/audit/message - Provide environment answers', async () => {
    expect(sessionId).toBeDefined();

    // Answer 2: env + expected/actual
    const res = await request(server)
      .post('/api/audit/message')
      .send({
        sessionId: sessionId,
        answer: "I am using Chrome browser on Windows 11. Expected behavior: connects successfully. Actual behavior: throws port 5432 error."
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('scores');
  });

  test('POST /api/audit/message - Complete the ticket audit (3rd question limit)', async () => {
    expect(sessionId).toBeDefined();

    // Answer 3: final details (forces completion via the 3-question limit)
    const res = await request(server)
      .post('/api/audit/message')
      .send({
        sessionId: sessionId,
        answer: "I have checked the logs and there are no other network errors."
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.isComplete).toBe(true);
    expect(res.body).toHaveProperty('triage');
    expect(res.body.triage).toHaveProperty('assignedTo');
    expect(res.body.triage).toHaveProperty('priority');
  });

  test('GET /api/sessions - Get session history list', async () => {
    const res = await request(server).get('/api/sessions');
    
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    
    // Check fields of history items
    const session = res.body.find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session.status).toEqual('assigned');
    expect(session.assignedTo).not.toBeNull();
  });
});

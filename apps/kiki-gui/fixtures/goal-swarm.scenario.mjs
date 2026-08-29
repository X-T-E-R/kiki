import { commitAssistant, sessionRecord, streamSteps, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_goal_swarm';
const ANSWER = 'Swarm mode is on and the goal state is live.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: goal + swarm' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // The GUI reads goal state from the transcript meta now (Slice B), not
      // from the REST snapshot — seed both so the resting session shows it.
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [],
          meta: {
            goal: {
              objective: 'Prepare the release evidence bundle',
              status: 'active',
              completionCriterion: 'All checks and screenshots are archived',
              budgetUsed: 6800,
              budgetLimit: 20000,
            },
          },
        },
      },
      goal: {
        goalId: 'goal-fixture-release',
        objective: 'Prepare the release evidence bundle',
        completionCriterion: 'All checks and screenshots are archived',
        status: 'active',
        turnsUsed: 2,
        tokensUsed: 6800,
        wallClockMs: 184000,
        budget: {
          tokenBudget: 20000,
          turnBudget: 8,
          wallClockBudgetMs: 900000,
          remainingTokens: 13200,
          remainingTurns: 6,
          remainingWallClockMs: 716000,
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      },
    },
  },
  onPrompt: [
    { frame: { type: 'turn.started', payload: { turnId: 3, origin: { kind: 'user' } } } },
    workChanged(true),
    {
      frame: {
        type: 'agent.status.updated',
        payload: { swarmMode: true },
      },
    },
    {
      frame: {
        type: 'goal.updated',
        payload: {
          snapshot: {
            goalId: 'goal-fixture-release',
            objective: 'Ship the fixture release',
            completionCriterion: 'All checks and screenshots are archived',
            status: 'active',
            turnsUsed: 3,
            tokensUsed: 7600,
            wallClockMs: 196000,
            budget: {
              tokenBudget: 20000,
              turnBudget: 8,
              wallClockBudgetMs: 900000,
              remainingTokens: 12400,
              remainingTurns: 5,
              remainingWallClockMs: 704000,
              tokenBudgetReached: false,
              turnBudgetReached: false,
              wallClockBudgetReached: false,
              overBudget: false,
            },
          },
          change: {
            kind: 'lifecycle',
            status: 'active',
            reason: 'Objective updated from prompt submission',
            actor: 'user',
          },
        },
      },
    },
    ...streamSteps('assistant.delta', 3, ANSWER, { per: 12, delay: 25 }),
    turnEnd(3),
    commitAssistant('$SID', ANSWER),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};

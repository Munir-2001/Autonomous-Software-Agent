// ReAct execution loop with runtime safety checks.
//
// Each `runAgentTurn(userInput)` call:
//   1. Builds a fresh `turnMessages` array containing system prompt
//      + the visible conversation history + the new user request.
//   2. Loops up to `MAX_ITERATIONS` times, asking the model what to do.
//   3. On each iteration:
//        - parses the model output
//        - if it produced an Action, executes the tool, appends the
//          observation, and continues
//        - if it produced a Final Answer (and no Action), accepts it
//          and returns
//        - if format is invalid, pushes a corrective observation
//   4. Bails out with a fallback answer if iterations are exhausted.
//
// Separation of memory (lab8-LLMs/07B-execution_loop-scratchpad_SOL):
//   - `messages` (long-lived) stores only user requests + final answers
//   - `turnMessages` (per-call) stores the internal Thought/Action/Obs
//     scratchpad and is discarded after the turn
//
// This prevents tool-observation noise from polluting future turns.

import { callModel } from './llm-client.js';
import { AGENT_PROMPT } from './prompts.js';
import {
  extractAction,
  extractFinalAnswer,
  countActions,
  hasBothActionAndFinalAnswer,
} from './parsers.js';

// Higher than the course's Deliveroo demo (12) because Level-2/3
// missions may need long chains of tool calls.
const MAX_ITERATIONS = 20;

/**
 * Run one full turn of the agent for a single user request.
 *
 * @param {string}                              userInput   the mission text
 * @param {Array<{role:string,content:string}>} messages    long-lived visible memory (mutated)
 * @param {Record<string,(input:string)=>Promise<string>>}  TOOLS  tool registry
 * @returns {Promise<string>} the final answer text
 */
export async function runAgentTurn(userInput, messages, TOOLS) {
  // Fresh scratchpad — system prompt + visible history + new request.
  const turnMessages = [
    { role: 'system', content: AGENT_PROMPT },
    ...messages.slice(1),               // skip the placeholder system msg in long-lived store
    { role: 'user', content: userInput },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`--- iter ${i + 1}/${MAX_ITERATIONS} ---`);

    const assistantMessage = await callModel(turnMessages, { temperature: 0 });
    console.log(`assistant:\n${assistantMessage}\n`);

    turnMessages.push({ role: 'assistant', content: assistantMessage });

    // Runtime safety checks.
    const numActions = countActions(assistantMessage);
    if (numActions > 1) {
      console.log(`[warn] ${numActions} actions in one message — executing first only`);
    }
    if (hasBothActionAndFinalAnswer(assistantMessage)) {
      console.log('[warn] Action + Final Answer in same message — executing Action, ignoring premature Final Answer');
    }

    // Defensive rule: Action takes precedence over Final Answer.
    const parsed = extractAction(assistantMessage);
    if (parsed) {
      const { action, actionInput } = parsed;
      let observation;
      if (TOOLS[action]) {
        try {
          observation = await TOOLS[action](actionInput);
        } catch (e) {
          observation = `Error: tool ${action} threw: ${e.message}`;
        }
      } else {
        observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(', ')}`;
      }
      console.log(`observation: ${observation}\n`);

      turnMessages.push({
        role: 'user',
        content:
          `Observation: ${observation}\n\n` +
          `Continue solving the original user request. ` +
          `If any requested information is still missing, choose the next Action. ` +
          `If all requested information has been observed, give the Final Answer. ` +
          `Remember: output exactly ONE Action OR ONE Final Answer.`,
      });
      continue;
    }

    // No Action — check for a Final Answer.
    const finalAnswer = extractFinalAnswer(assistantMessage);
    if (finalAnswer) {
      // Persist only the user/assistant pair in the long-lived store.
      messages.push({ role: 'user', content: userInput });
      messages.push({ role: 'assistant', content: finalAnswer });
      return finalAnswer;
    }

    // Neither — push corrective observation and retry.
    const correction = 'Error: invalid format. Output exactly ONE Action or ONE Final Answer using the strict format.';
    console.log(`[warn] ${correction}`);
    turnMessages.push({ role: 'user', content: `Observation: ${correction}` });
  }

  // Iteration cap hit.
  const fallback = 'I could not complete the request within the maximum number of iterations.';
  messages.push({ role: 'user', content: userInput });
  messages.push({ role: 'assistant', content: fallback });
  return fallback;
}

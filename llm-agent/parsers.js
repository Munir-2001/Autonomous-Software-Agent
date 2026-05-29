// Parsers for the LLM's text output.
//
// The LLM emits one of two text formats per turn:
//
//   Thought: ...                       Thought: ...
//   Action: <tool>                     Final Answer: <text>
//   Action Input: <input>
//
// These helpers extract structured info from the raw text and
// detect runtime violations (multiple actions, mixed Action + Final
// Answer). Lifted verbatim from the course's lab8-LLMs reference
// (07C-execution_loop-runtime-check_SOL.mjs).

export function extractAction(text) {
  const actionMatch = text.match(/^Action:\s*(.+)$/im);
  const actionInputMatch = text.match(/^Action Input:\s*(.+)$/im);
  if (!actionMatch || !actionInputMatch) return null;

  const action = actionMatch[1].trim();
  // The course's prompt explicitly forbids "Action: None" — but Llama
  // generates it anyway when uncertain. Treat it as no-action.
  if (action.toLowerCase() === 'none') return null;

  return { action, actionInput: actionInputMatch[1].trim() };
}

export function extractFinalAnswer(text) {
  const match = text.match(/^Final Answer:\s*([\s\S]*)$/im);
  return match ? match[1].trim() : null;
}

export function countActions(text) {
  const matches = text.match(/^Action:\s*.+$/gim);
  return matches ? matches.length : 0;
}

export function hasBothActionAndFinalAnswer(text) {
  const hasAction = /^Action:\s*(.+)$/im.test(text);
  const hasFinal  = /^Final Answer:\s*[\s\S]*$/im.test(text);
  if (!hasAction || !hasFinal) return false;
  // Don't count "Action: None" as a real action.
  const actionLine = text.match(/^Action:\s*(.+)$/im);
  return actionLine && actionLine[1].trim().toLowerCase() !== 'none';
}

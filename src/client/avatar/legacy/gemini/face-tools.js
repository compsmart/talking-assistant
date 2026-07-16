// Function-calling tools that let the Live model drive the face. Declared in
// the session setup; when the model emits a toolCall we run the handler and
// send back a toolResponse. Expressions and gestures mirror the animator API.

import { EXPRESSIONS } from '../face/morphs.js';

const EXPRESSION_NAMES = Object.keys(EXPRESSIONS); // neutral, happy, sad, ...
const GESTURE_NAMES = [
  'noseTwitch', 'nostrilFlare', 'pout', 'lipPress',
  'smirkL', 'smirkR', 'browFlash', 'browKnit', 'squint',
];

export const FACE_TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: 'set_expression',
      description: 'Briefly show a facial expression matching the emotional tone of what you are saying right now -- e.g. happy when pleased, sad when sympathetic, surprised at unexpected news, thinking while considering. The expression is short-lived and fades back to neutral after a few seconds, so call it again as your mood shifts through the conversation.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            enum: EXPRESSION_NAMES,
            description: 'The expression to hold.',
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'play_gesture',
      description: 'Play a brief, subtle facial micro-gesture for emphasis or personality. Use sparingly for punctuation -- a browFlash on a greeting, a smirk on a joke, a pout, a squint of doubt. These are quick and layer on top of the current expression.',
      parameters: {
        type: 'object',
        properties: {
          gesture: {
            type: 'string',
            enum: GESTURE_NAMES,
            description: 'The micro-gesture to play once.',
          },
        },
        required: ['gesture'],
      },
    },
  ],
}];

// Guidance appended to the system prompt so the model knows to emote.
export const FACE_TOOL_SYSTEM_HINT =
  ' You control a 3D face. Use the set_expression and play_gesture tools to emote naturally as you speak -- match your expression to your mood, and add occasional gestures for personality. Keep emoting subtle and human, not constant.';

// Run one function call against the animator. Returns a small result object.
// Model-set expressions punctuate the current line, then fade back to neutral.
const EXPRESSION_HOLD_SECONDS = 3;

export function runFaceTool(animator, name, args = {}) {
  if (name === 'set_expression') {
    const expr = args.expression;
    if (!EXPRESSION_NAMES.includes(expr)) return { ok: false, error: `unknown expression: ${expr}` };
    animator.setExpression(expr, EXPRESSION_HOLD_SECONDS);
    return { ok: true, expression: expr };
  }
  if (name === 'play_gesture') {
    const g = args.gesture;
    if (!GESTURE_NAMES.includes(g)) return { ok: false, error: `unknown gesture: ${g}` };
    animator.gesture(g);
    return { ok: true, gesture: g };
  }
  return { ok: false, error: `unknown tool: ${name}` };
}



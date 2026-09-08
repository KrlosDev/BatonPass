// How many tokens a model can hold - published facts, nothing guessed or
// fetched. First match wins, so ORDER IS LOAD-BEARING: /haiku/ goes first.
const WINDOWS = [
  { match: /haiku/i, tokens: 200000 },
  { match: /opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable|mythos/i, tokens: 1000000 },
];

// Older models were 200k, and an unrecognised name is likelier to be one of
// those. The widget prints the denominator, so a wrong guess is visible.
const FALLBACK = 200000;

function contextWindowFor(model) {
  const found = WINDOWS.find((w) => w.match.test(model || ''));
  return found ? found.tokens : FALLBACK;
}

module.exports = { contextWindowFor, FALLBACK };

'use strict';

const GEMMA4_MODEL = /(?:^|[\/_\-.])gemma[-_. ]?4(?:$|[\/_\-.])/i;

function isGemma4Model(model) {
  return typeof model === 'string' && GEMMA4_MODEL.test(model);
}

function stripReasoningFields(message) {
  if (!message || message.role !== 'assistant') return;
  delete message.reasoning_content;
  delete message.reasoning;
  delete message.reasoning_text;
}

function handle(data) {
  if (!isGemma4Model(data?.model) || !Array.isArray(data?.messages)) return;
  for (const message of data.messages) stripReasoningFields(message);
}

module.exports = {
  handle,
  isGemma4Model,
  stripReasoningFields,
};

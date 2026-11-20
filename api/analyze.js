/*
 * Vercel serverless analysis endpoint for QuizLens AI.
 *
 * The browser never receives OPENAI_API_KEY. This endpoint deliberately does
 * not persist request images or log question content.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;
const rateWindows = new Map();

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'question',
    'question_type',
    'options',
    'suggested_answer',
    'answer_text',
    'explanation',
    'confidence',
    'needs_verification',
    'ambiguity_detected',
    'audit_flags',
    'status',
  ],
  properties: {
    question: { type: 'string' },
    question_type: { type: 'string', enum: ['single_choice', 'multiple_choice', 'assertion_reason', 'unknown'] },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'text'],
        properties: { label: { type: 'string' }, text: { type: 'string' } },
      },
    },
    suggested_answer: { type: 'array', items: { type: 'string' } },
    answer_text: { type: 'string' },
    explanation: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'insufficient_information'] },
    needs_verification: { type: 'boolean' },
    ambiguity_detected: { type: 'boolean' },
    audit_flags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['ai_suggested', 'unclear', 'needs_better_capture'] },
  },
};

function sendJson(response, status, body) {
  response.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.json(body);
}

function getClientKey(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || request.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function withinRateLimit(request) {
  const key = getClientKey(request);
  const time = Date.now();
  const active = (rateWindows.get(key) || []).filter((createdAt) => time - createdAt < WINDOW_MS);
  if (active.length >= MAX_REQUESTS_PER_WINDOW) return false;
  active.push(time);
  rateWindows.set(key, active);
  return true;
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function sanitizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((option, index) => ({
    label: cleanText(option?.label, 12) || String.fromCharCode(65 + index),
    text: cleanText(option?.text, 1_000),
  })).filter((option) => option.text);
}

function isAllowedImage(dataUrl) {
  return typeof dataUrl === 'string'
    && dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl);
}

function validateAnalysis(value) {
  if (!value || typeof value !== 'object') return null;
  const allowedTypes = new Set(['single_choice', 'multiple_choice', 'assertion_reason', 'unknown']);
  const allowedConfidence = new Set(['high', 'medium', 'low', 'insufficient_information']);
  const allowedStatus = new Set(['ai_suggested', 'unclear', 'needs_better_capture']);
  if (typeof value.question !== 'string' || !allowedTypes.has(value.question_type) || !Array.isArray(value.options)
    || !Array.isArray(value.suggested_answer) || typeof value.answer_text !== 'string'
    || typeof value.explanation !== 'string' || !allowedConfidence.has(value.confidence)
    || typeof value.needs_verification !== 'boolean' || typeof value.ambiguity_detected !== 'boolean'
    || !Array.isArray(value.audit_flags) || !allowedStatus.has(value.status)) return null;
  const options = value.options.map((option) => ({ label: cleanText(option?.label, 12), text: cleanText(option?.text, 1_000) }));
  if (options.some((option) => !option.label || !option.text)) return null;
  return {
    question: cleanText(value.question, 6_000),
    question_type: value.question_type,
    options,
    suggested_answer: value.suggested_answer.map((answer) => cleanText(answer, 100)).filter(Boolean).slice(0, 10),
    answer_text: cleanText(value.answer_text, 2_000),
    explanation: cleanText(value.explanation, 6_000),
    confidence: value.confidence,
    needs_verification: value.needs_verification,
    ambiguity_detected: value.ambiguity_detected,
    audit_flags: value.audit_flags.map((flag) => cleanText(flag, 240)).filter(Boolean).slice(0, 16),
    status: value.status,
  };
}

function buildPrompt(questionText, options, hasImage) {
  const submittedOptions = options.length ? options.map((option) => `${option.label}. ${option.text}`).join('\n') : '(No typed options were supplied.)';
  return [
    'Analyze this authorized practice-question capture as an audit aid, never as an official answer key.',
    'Read the question and visible options. If the capture is unclear, incomplete, or lacks enough context, return status "needs_better_capture" or "unclear" and use low or insufficient_information confidence.',
    'Do not claim independent verification. Mark needs_verification true unless the question is self-evidently unambiguous, and still describe the result as an AI suggestion.',
    'Identify ambiguity, multiple defensible answers, missing information, stale factual premises, duplicate-looking wording, or OCR uncertainty in audit_flags where appropriate.',
    'Give a concise useful explanation, not hidden reasoning or chain-of-thought.',
    hasImage ? 'An image capture is included for visual text extraction.' : 'No image capture is included; only typed text is available.',
    `Typed question:\n${questionText || '(No typed question was supplied.)'}`,
    `Typed options:\n${submittedOptions}`,
  ].join('\n\n');
}

module.exports = async function analyze(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'method_not_allowed' });
  }
  if (!process.env.OPENAI_API_KEY) return sendJson(response, 503, { error: 'ai_not_configured', message: 'The server-side AI service has not been configured.' });
  if (!withinRateLimit(request)) return sendJson(response, 429, { error: 'rate_limited', message: 'Too many analysis requests. Please wait a minute and retry.' });

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const questionText = cleanText(body.questionText, 6_000);
  const options = sanitizeOptions(body.options);
  const imageData = body.imageData;
  if (!questionText && !isAllowedImage(imageData)) return sendJson(response, 400, { error: 'missing_question_content', message: 'Provide question text or an image capture.' });
  if (imageData && !isAllowedImage(imageData)) return sendJson(response, 400, { error: 'invalid_image', message: 'Use a PNG, JPEG, or WebP capture smaller than the configured size limit.' });

  const content = [{ type: 'input_text', text: buildPrompt(questionText, options, Boolean(imageData)) }];
  if (imageData) content.push({ type: 'input_image', image_url: imageData, detail: 'high' });

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-6.2-astra',
        input: [
          { role: 'system', content: 'You are QuizLens AI, an evidence-conscious question auditing assistant. You never present an AI estimate as an independently verified answer.' },
          { role: 'user', content },
        ],
        max_output_tokens: 1_400,
        text: { format: { type: 'json_schema', name: 'quiz_audit', strict: true, schema: ANALYSIS_SCHEMA } },
      }),
    });
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) return sendJson(response, upstream.status >= 400 && upstream.status < 500 ? 502 : 503, { error: 'analysis_unavailable', message: 'The AI service could not complete this request. Your captured record is still saved.' });
    const text = payload?.output_text;
    if (!text) return sendJson(response, 422, { error: 'analysis_incomplete', message: 'The AI service did not return a usable structured response.' });
    const analysis = validateAnalysis(JSON.parse(text));
    if (!analysis) return sendJson(response, 422, { error: 'analysis_invalid', message: 'The AI result did not match the required audit schema. You can retry safely.' });
    return sendJson(response, 200, { analysis });
  } catch (error) {
    return sendJson(response, 503, { error: 'analysis_failed', message: 'The AI request failed. Your captured record remains available for retry.' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const assert = require('node:assert/strict');

delete process.env.OPENAI_API_KEY;
const handler = require('../api/analyze.js');

async function invoke(request) {
  const result = { headers: {} };
  const response = {
    status(code) { result.status = code; return this; },
    setHeader(key, value) { result.headers[key] = value; return this; },
    json(body) { result.body = body; return this; },
  };
  await handler({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, ...request }, response);
  return result;
}

(async () => {
  const notConfigured = await invoke({ method: 'POST', body: { questionText: 'Which option is correct?' } });
  assert.equal(notConfigured.status, 503);
  assert.equal(notConfigured.body.error, 'ai_not_configured');
  assert.equal(notConfigured.headers['Cache-Control'], 'no-store');

  const methodNotAllowed = await invoke({ method: 'GET', body: {} });
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.body.error, 'method_not_allowed');
  assert.equal(methodNotAllowed.headers.Allow, 'POST');

  console.log('api-analyze configuration and request guards passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

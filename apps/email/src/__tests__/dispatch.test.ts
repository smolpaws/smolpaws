import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchEmailToAgentServer } from '../agentDispatch.js';
import { buildReplySubject } from '../resendClient.js';

test('email dispatch fails closed instead of silently dropping unconfigured intake', async () => {
  await assert.rejects(dispatchEmailToAgentServer({ sender: 'human@example.com', emailId: 'email-1' }, {}), /must be configured/);
});

test('buildReplySubject preserves reply prefixes', () => {
  assert.equal(buildReplySubject('hello'), 'Re: hello');
  assert.equal(buildReplySubject('Re: hello'), 'Re: hello');
  assert.equal(buildReplySubject(undefined), 'Re: (no subject)');
});

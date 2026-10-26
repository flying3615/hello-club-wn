import test from 'node:test';
import assert from 'node:assert/strict';
import { revealSlot, visibleModal, waitForFinalReview } from '../src/booking-submit.mjs';

test('selects the last visible booking modal only', () => {
  let selector;
  const expected = { id: 'visible-modal' };
  const page = {
    locator: (value) => {
      selector = value;
      return { last: () => expected };
    },
  };

  assert.equal(visibleModal(page), expected);
  assert.equal(selector, '.modal-wrapper:visible');
});

test('waits for the final confirmation action before reviewing the booking', async () => {
  const calls = [];
  const modal = {
    locator: (selector) => {
      calls.push({ selector });
      return {
        filter: (options) => {
          calls.push({ options });
          return { waitFor: async (options) => calls.push({ waitFor: options }) };
        },
      };
    },
  };

  await waitForFinalReview(modal);

  assert.deepEqual(calls, [
    { selector: 'button' },
    { options: { hasText: 'CONFIRM BOOKING' } },
    { waitFor: { state: 'visible', timeout: 5_000 } },
  ]);
});

test('reveals the requested grid slot before an interaction', async () => {
  let options;
  const slot = {
    evaluate: async (callback) => callback({
      scrollIntoView: (value) => { options = value; },
    }),
  };

  await revealSlot(slot);

  assert.deepEqual(options, { block: 'center', inline: 'center' });
});

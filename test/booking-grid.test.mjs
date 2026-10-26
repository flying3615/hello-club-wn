import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGridSnapshot } from '../src/booking-grid.mjs';

function column(court, overrides = {}) {
  return {
    court,
    slots: Array.from({ length: 48 }, (_, index) => ({
      className: 'BookingGrid-cell Slot available',
      text: `${index}`,
      ...overrides[index],
    })),
  };
}

test('maps 48 DOM slots to half-hour intervals', () => {
  const [result] = parseGridSnapshot([column('Court 4')]);
  assert.equal(result.slots.length, 48);
  assert.deepEqual(result.slots[0], {
    start: '00:00', end: '00:30', available: true, peak: false, text: '0',
  });
  assert.equal(result.slots[44].start, '22:00');
  assert.equal(result.slots[44].end, '22:30');
  assert.equal(result.slots[47].end, '24:00');
});

test('distinguishes free, peak-free and disabled slots', () => {
  const [result] = parseGridSnapshot([column('Court 5', {
    34: { className: 'BookingGrid-cell Slot peak available', text: '5:00pm peak time' },
    35: { className: 'BookingGrid-cell Slot peak disabled', text: 'Club' },
  })]);
  assert.equal(result.slots[34].available, true);
  assert.equal(result.slots[34].peak, true);
  assert.equal(result.slots[35].available, false);
  assert.equal(result.slots[35].peak, true);
});

test('rejects incomplete court columns', () => {
  assert.throws(() => parseGridSnapshot([{ court: 'Court 6', slots: [] }]), /Invalid grid column/);
});

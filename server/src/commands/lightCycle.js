'use strict';

/**
 * ETS2/ATS common L-key electric lights cycle (forward only):
 *   off → parking → low(+parking) → off
 *
 * Telemetry coupling: turning parking off forces low off (both clear in off state).
 * From low, one forward tap goes to off (not parking-only).
 */

const CYCLE = [
  { parking: false, beamLow: false }, // 0 off
  { parking: true, beamLow: false }, // 1 parking
  { parking: true, beamLow: true }, // 2 low (parking typically stays on)
];

function classifyLightPos(lights) {
  const parking = Boolean(lights && lights.parking);
  const beamLow = Boolean(lights && lights.beamLow);
  if (!parking && !beamLow) return 0;
  if (parking && beamLow) return 2;
  if (parking && !beamLow) return 1;
  if (!parking && beamLow) return 2;
  return 0;
}

function positionsEqual(a, b) {
  return Boolean(a.parking) === Boolean(b.parking) && Boolean(a.beamLow) === Boolean(b.beamLow);
}

/**
 * @param {{parking:boolean,beamLow:boolean}} lights
 * @param {'lights.parking'|'lights.beamLow'} action
 * @param {boolean} value target
 * @returns {{taps:number, noop:boolean, from:number, to:number, note?:string}}
 */
function planSharedLightCycle(lights, action, value) {
  const from = classifyLightPos(lights);
  let to = from;
  let note;

  if (action === 'lights.parking') {
    if (value === true) {
      if (from === 1 || from === 2) {
        return { taps: 0, noop: true, from, to: from };
      }
      to = 1;
    } else if (from === 0) {
      return {
        taps: 0,
        noop: true,
        from,
        to: 0,
        note: 'parking off also implies low off (coupled)',
      };
    } else {
      to = 0;
      note = 'turning parking off clears low beam (cycle coupling)';
    }
  } else if (action === 'lights.beamLow') {
    if (value === true) {
      if (from === 2) {
        return { taps: 0, noop: true, from, to: 2 };
      }
      to = 2;
    } else if (from !== 2) {
      return { taps: 0, noop: true, from, to: from };
    } else {
      to = 0;
      note = 'low off via cycle goes to full off, not parking-only';
    }
  } else {
    return { taps: 0, noop: true, from, to: from, note: 'not a shared-cycle action' };
  }

  const taps = (to - from + CYCLE.length) % CYCLE.length;
  return {
    taps,
    noop: taps === 0,
    from,
    to,
    note,
    target: CYCLE[to],
  };
}

function planToggleTap(currentBool, targetBool) {
  if (Boolean(currentBool) === Boolean(targetBool)) {
    return { taps: 0, noop: true };
  }
  return { taps: 1, noop: false };
}

module.exports = {
  CYCLE,
  classifyLightPos,
  positionsEqual,
  planSharedLightCycle,
  planToggleTap,
};

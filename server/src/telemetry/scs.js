'use strict';

/**
 * Real telemetry via trucksim-telemetry → RenCloud scs-sdk-plugin shared memory.
 * Units from kniffen.dev/TruckSim-Telemetry Units + SCSSDKTelemetry:
 *   speed: m/s → km/h (*3.6)
 *   fuel / fuelCapacity: liters → fuelPct
 *   airPressure: psi
 *   wipers: SDK boolean only → contract 'off' | '1' (never fabricate 2/3/auto)
 */

function tryLoadTruckSim() {
  try {
    return require('trucksim-telemetry');
  } catch (err) {
    return { error: err };
  }
}

/** Live echo: only off vs on; on is labeled '1' (not a claim of discrete level 2/3). */
function mapSdkWipers(wipersBool) {
  return wipersBool ? '1' : 'off';
}

function mapSdkToTelemetry(data) {
  const fuelCap = Number(data.fuelCapacity) || 0;
  const fuel = Number(data.fuel) || 0;
  const fuelPct = fuelCap > 0 ? Math.min(100, Math.max(0, (fuel / fuelCap) * 100)) : 0;
  const gear = Number.isFinite(data.gearDashboard) ? data.gearDashboard : data.gear;

  return {
    connected: Boolean(data.sdkActive),
    speedKmh: Math.round((Number(data.speed) || 0) * 3.6 * 10) / 10,
    engineRpm: Math.round(Number(data.engineRpm) || 0),
    gear: Number.isFinite(gear) ? gear : 0,
    fuelPct: Math.round(fuelPct * 10) / 10,
    airPressure: Math.round((Number(data.airPressure) || 0) * 10) / 10,
    lights: {
      parking: Boolean(data.lightsParking),
      beamLow: Boolean(data.lightsBeamLow),
      beamHigh: Boolean(data.lightsBeamHigh),
      blinkerLeft: Boolean(data.blinkerLeftOn || data.blinkerLeftActive),
      blinkerRight: Boolean(data.blinkerRightOn || data.blinkerRightActive),
      hazard: Boolean(data.lightsHazard),
    },
    wipers: mapSdkWipers(Boolean(data.wipers)),
    handbrake: Boolean(data.parkBrake),
    diffLock: Boolean(data.differentialLock),
    liftAxle: Boolean(data.liftAxle),
    cruise: Boolean(data.cruiseControl),
    engineOn: Boolean(data.engineEnabled),
  };
}

function disconnectedSnapshot() {
  return {
    connected: false,
    speedKmh: 0,
    engineRpm: 0,
    gear: 0,
    fuelPct: 0,
    airPressure: 0,
    lights: {
      parking: false,
      beamLow: false,
      beamHigh: false,
      blinkerLeft: false,
      blinkerRight: false,
      hazard: false,
    },
    wipers: 'off',
    handbrake: false,
    diffLock: false,
    liftAxle: false,
    cruise: false,
    engineOn: false,
  };
}

function createScsTelemetry() {
  const loaded = tryLoadTruckSim();
  if (loaded.error || typeof loaded.getData !== 'function') {
    return {
      available: false,
      reason: loaded.error
        ? String(loaded.error.message || loaded.error)
        : 'trucksim-telemetry missing getData',
    };
  }

  const { getData } = loaded;
  let lastConnected = null;

  function read() {
    let data = null;
    try {
      data = getData();
    } catch (err) {
      if (lastConnected !== false) {
        console.warn('[telemetry] getData threw, treating as disconnected:', err.message);
        lastConnected = false;
      }
      return disconnectedSnapshot();
    }

    if (!data) {
      if (lastConnected !== false) {
        console.warn('[telemetry] shared memory unavailable → connected=false');
        lastConnected = false;
      }
      return disconnectedSnapshot();
    }

    const snap = mapSdkToTelemetry(data);
    if (lastConnected !== snap.connected) {
      console.log(`[telemetry] sdk connected=${snap.connected}`);
      lastConnected = snap.connected;
    }
    return snap;
  }

  return {
    available: true,
    reason: 'ok',
    read,
  };
}

module.exports = { createScsTelemetry, mapSdkToTelemetry, mapSdkWipers, disconnectedSnapshot };

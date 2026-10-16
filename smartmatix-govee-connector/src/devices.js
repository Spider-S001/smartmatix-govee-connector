'use strict';

/**
 * devices.js – Verwaltung der HCU-Geräte
 *
 * Hält die Geräte, die dieses Plugin gegenüber der HCU (Connect API 1.0.1)
 * repräsentiert, im Speicher und persistiert sie in der devices.json.
 *
 * Jedes Govee-Gerät wird auf einen oder mehrere HCU-Geräte ("Kanäle")
 * abgebildet – siehe goveeMapping.js. Die deviceId ist deterministisch
 * (govee-<mac>-<kanal>), damit ein in der HCU gelöschtes Gerät beim
 * Reinkludieren wieder dieselbe ID erhält.
 */

const log          = require('./logger');
const devicesStore = require('./devicesStore');

// Map<deviceId, deviceObject>
let registry = load();

function load() {
  const map = new Map(Object.entries(devicesStore.load('devices')));
  log.info(`${map.size} HCU-Geraet(e) aus devices.json geladen.`);
  return map;
}

function persist() {
  devicesStore.save('devices', Object.fromEntries(registry));
}

/** Kompakter Schlüssel eines Govee-Geräts (MAC ohne Trennzeichen). */
function goveeKey(goveeId) {
  return String(goveeId).replace(/[^0-9a-z]/gi, '').toUpperCase();
}

// Govee-Gerätetyp (devices.types.*) > modelType in der HCU
const MODEL_TYPES = {
  'devices.types.light':          'GoveeLight',
  'devices.types.socket':         'GoveePlug',
  'devices.types.thermometer':    'GoveeThermometer',
  'devices.types.sensor':         'GoveeSensor',
  'devices.types.heater':         'GoveeHeater',
  'devices.types.air_purifier':   'GoveeAirPurifier',
  'devices.types.humidifier':     'GoveeHumidifier',
  'devices.types.dehumidifier':   'GoveeDehumidifier',
  'devices.types.fan':            'GoveeFan',
  'devices.types.aroma_diffuser': 'GoveeAromaDiffuser',
  'devices.types.ice_maker':      'GoveeIceMaker',
  'devices.types.kettle':         'GoveeKettle',
  'devices.types.box':            'GoveeBox',
};

/** modelType für die HCU: "Govee" + Govee-Gerätetyp, z. B. GoveeLight, GoveePlug. */
function modelTypeOf(goveeDevice) {
  if (MODEL_TYPES[goveeDevice.type]) return MODEL_TYPES[goveeDevice.type];
  // Unbekannter Typ: aus "devices.types.xyz_abc" > "GoveeXyzAbc"
  const raw = String(goveeDevice.type ?? '').replace(/^devices\.types\./, '');
  const camel = raw.split(/[^a-z0-9]+/i).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
  return `Govee${camel || 'Device'}`;
}

function makeDeviceId(goveeId, channel) {
  return `govee-${goveeKey(goveeId).toLowerCase()}-${channel}`;
}

function getAll()               { return Array.from(registry.values()); }
function getById(deviceId)      { return registry.get(deviceId) ?? null; }
function getByGoveeId(goveeId)  { return getAll().filter(d => d.goveeId === goveeId); }

/** Aktive Geräte: an die HCU gemeldet und dort nicht gelöscht. */
function getActive() {
  return getAll().filter(d => d.alreadyIncluded && !d.excluded);
}

/**
 * Legt ein HCU-Gerät für einen Kanal eines Govee-Geräts an (falls noch nicht vorhanden).
 * @returns {object} das (neue oder bestehende) Gerät
 */
function ensure(goveeDevice, channelDef, friendlyName) {
  const deviceId = makeDeviceId(goveeDevice.id, channelDef.channel);
  const existing = registry.get(deviceId);
  if (existing) {
    existing.modelType = modelTypeOf(goveeDevice);
    // Gerätetyp oder Feature-Satz hat sich geändert (z. B. neue Capabilities) > anpassen
    if (existing.deviceType !== channelDef.deviceType) {
      existing.deviceType = channelDef.deviceType;
      existing.features   = channelDef.features;
    } else {
      for (const f of channelDef.features) {
        if (!existing.features.some(e => e.type === f.type)) existing.features.push(f);
      }
      existing.features = existing.features.filter(e => channelDef.features.some(f => f.type === e.type));
    }
    persist();
    return existing;
  }
  const device = {
    deviceType:      channelDef.deviceType,
    deviceId,
    friendlyName:    sanitize(friendlyName),
    modelType:       modelTypeOf(goveeDevice),
    features:        channelDef.features,
    goveeId:         goveeDevice.id,
    channel:         channelDef.channel,
    alreadyIncluded: false,
    excluded:        false,
  };
  registry.set(deviceId, device);
  persist();
  log.info(`HCU-Geraet angelegt: ${deviceId} (${device.deviceType}) fuer "${device.friendlyName}"`);
  return device;
}

/** Entfernt ein HCU-Gerät aus der Registry. */
function remove(deviceId) {
  if (registry.delete(deviceId)) {
    persist();
    log.info(`HCU-Geraet entfernt: ${deviceId}`);
  }
}

/** Setzt Flags (alreadyIncluded, excluded) für mehrere Geräte. */
function setFlags(deviceIds, flags) {
  let changed = false;
  for (const id of deviceIds) {
    const d = registry.get(id);
    if (!d) continue;
    Object.assign(d, flags);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Übernimmt Features in das Gerät (Werte werden überschrieben, neue
 * Feature-Typen ignoriert) und persistiert.
 */
function mergeFeatures(deviceId, features) {
  const d = registry.get(deviceId);
  if (!d) return;
  for (const incoming of features) {
    const existing = d.features.find(f => f.type === incoming.type);
    if (existing) Object.assign(existing, incoming);
  }
  persist();
}

/**
 * Nur die Felder des Device-Schemas der Connect API.
 *
 * Lampen mit Farbe und Farbtemperatur führen intern den inaktiven Farbmodus
 * mit dem "Ignorieren"-Wert (siehe goveeMapping.colorModeFeatures).
 *   - DISCOVER (forDiscover): beide Features mit gültigen Startwerten, damit
 *     die HCU Farbrad und Weiß-Regler anlegt.
 *   - Status: nur das Feature des aktiven Modus. Erhält die HCU Farbe und
 *     Farbtemperatur gleichzeitig, kann die Homematic IP App den falschen
 *     Modus anzeigen.
 */
function toHcu(device, { forDiscover = false } = {}) {
  return {
    deviceId:     device.deviceId,
    deviceType:   device.deviceType,
    friendlyName: device.friendlyName,
    modelType:    device.modelType,
    features:     forDiscover ? discoverFeatures(device.features) : statusFeatures(device.features),
  };
}

function isIgnoreValue(f) {
  if (f.type === 'color')            return Number(f.hue) >= 361 || Number(f.saturationLevel) >= 1.005;
  if (f.type === 'colorTemperature') return Number(f.colorTemperature) >= 10050;
  return false;
}

/** Features für STATUS_RESPONSE / STATUS_EVENT: inaktiven Farbmodus weglassen. */
function statusFeatures(features) {
  return (features ?? []).filter(f => !isIgnoreValue(f));
}

/** Features für DISCOVER_RESPONSE: "Ignorieren"-Werte durch gültige Startwerte ersetzen. */
function discoverFeatures(features) {
  return (features ?? []).map((f) => {
    if (!isIgnoreValue(f)) return f;
    if (f.type === 'color') return { type: 'color', hue: 0, saturationLevel: 0 };
    const min = f.minimalColorTemperature ?? 2000;
    const max = f.maximumColorTemperature ?? 6500;
    return { ...f, colorTemperature: Math.round((min + max) / 2) };
  });
}

function reload() { registry = load(); }

/** Bereinigt kaputte Encoding-Zeichen (HCU-Bug Workaround). */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/�/g, '?');
}

module.exports = {
  getAll, getById, getByGoveeId, getActive,
  ensure, remove, setFlags, mergeFeatures, toHcu, statusFeatures, reload,
  goveeKey, makeDeviceId, modelTypeOf, sanitize,
};

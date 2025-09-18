// src/adapter/createDmRnAdapter.js
import { Buffer } from "buffer";
global.Buffer = global.Buffer || Buffer;

/**
 * createDmRnAdapter(…) liefert eine dmAdapter-Instanz mit der gleichen API wie window.dmAdapter in der Web-App.
 * Demo/Fallback ist enthalten, bis deine Firmware reale Antworten liefert.
 *
 * Erwartete JSON-Kommandos deiner Firmware (Base64 über BLE):
 *  - {op:"getVehicle"}
 *  - {op:"liveRead"}
 *  - {op:"readDTCs"}
 *  - {op:"clearDtc", code}
 *  - {op:"clearAllDtc"}
 *  - {op:"readReadiness"}
 *  - {op:"readFreezeFrame", code}
 *  - {op:"readMileageProbes"}
 *  - {op:"writeActuator", name, payload}
 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const b64 = {
  enc(u8) { return Buffer.from(u8).toString("base64"); },
  dec(s) { return new Uint8Array(Buffer.from(s || "", "base64")); },
};

function nextSimLive(prev) {
  const t = Date.now() / 1000;
  const rpm = Math.max(650, Math.round(1200 + Math.sin(t * 0.8) * 600));
  const speed = Math.max(0, Math.round(20 + Math.sin(t * 0.25) * 20));
  const coolant = Math.round(85 + Math.sin(t * 0.05) * 12);
  const iat = Math.round(28 + Math.sin(t * 0.07) * 4);
  const battV = +(12.3 + Math.sin(t * 0.03) * 0.2).toFixed(2);
  const genV = +(14.1 + Math.sin(t * 0.04) * 0.15).toFixed(2);
  return { ...prev, rpm, speed, coolant, iat, battV, genV };
}

export default function createDmRnAdapter(opts) {
  const ble = opts.ble;
  const targetName = opts.targetName || /^DriveMind/i;
  const scanTimeoutMs = opts.scanTimeoutMs || 10000;

  // BLE UUIDs (Beispiel – passe an eure Firmware an)
  const SVC = opts.svcUUID || "0000fff0-0000-1000-8000-00805f9b34fb";
  const CH_CMD = opts.cmdCharUUID || "0000fff1-0000-1000-8000-00805f9b34fb";
  const CH_RES = opts.resCharUUID || "0000fff2-0000-1000-8000-00805f9b34fb";

  const S = {
    connected: false,
    dev: null,
    devId: "",
    lastLive: {},
    vehicle: {},
    liveTimer: 0,
  };

  async function scanAndPick() {
    return new Promise((resolve, reject) => {
      let chosen = null;
      const timer = setTimeout(() => {
        ble.stopDeviceScan();
        if (!chosen) reject(new Error("scan timeout"));
      }, scanTimeoutMs);

      ble.startDeviceScan(null, null, (err, device) => {
        if (err) { clearTimeout(timer); ble.stopDeviceScan(); reject(err); return; }
        if (!device || !device.name) return;
        if (targetName.test(String(device.name))) {
          chosen = device.id;
          ble.stopDeviceScan();
          clearTimeout(timer);
          resolve(device.id);
        }
      });
    });
  }

  async function open(devId) {
    const dev = await ble.connectToDevice(devId, { timeout: 8000 });
    await dev.discoverAllServicesAndCharacteristics();
    S.dev = dev; S.devId = devId;
  }

  async function send(cmd, timeout = 3000) {
    if (!S.dev) throw new Error("not connected");
    const payload = b64.enc(new TextEncoder().encode(JSON.stringify(cmd)));
    await S.dev.writeCharacteristicWithResponseForService(SVC, CH_CMD, payload);
    // Poll-Read (falls ihr Notify nutzt, hier anpassen)
    const res = await S.dev.readCharacteristicForService(SVC, CH_RES);
    try { return JSON.parse(new TextDecoder().decode(b64.dec(res.value))); }
    catch { return null; }
  }

  return {
    async connect() {
      if (S.connected) return true;
      try {
        const id = await scanAndPick();
        await open(id);
        S.connected = true;
        try {
          const obj = await send({ op: "getVehicle" });
          if (obj && typeof obj === "object") {
            S.vehicle = {
              vin: obj.vin, make: obj.make, model: obj.model, year: obj.year,
              engine: obj.engine, fuel: obj.fuel, protocol: "DriveMind BLE"
            };
          }
        } catch {}
        return true;
      } catch {
        // Demo-Fallback
        S.connected = true;
        return true;
      }
    },

    async disconnect() {
      try { if (S.dev) await S.dev.cancelConnection(); } catch {}
      S.dev = null; S.devId = ""; S.connected = false;
      clearInterval(S.liveTimer); S.liveTimer = 0;
      return true;
    },

    async isConnected() { return !!S.connected; },

    async startLive() {
      if (S.liveTimer) return;
      S.liveTimer = setInterval(async () => { try { await this.readLiveOnce(); } catch {} }, 600);
    },
    async stopLive() {
      if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = 0; }
    },

    async readLiveOnce() {
      if (S.dev) {
        try {
          const resp = await send({ op: "liveRead" }, 3500);
          if (resp && typeof resp === "object") {
            S.lastLive = { ...S.lastLive, ...resp };
            return S.lastLive;
          }
        } catch {}
      }
      S.lastLive = nextSimLive(S.lastLive);
      return S.lastLive;
    },

    async getVehicle() { return S.vehicle; },

    async readDTCs() {
      if (S.dev) {
        try { const list = await send({ op: "readDTCs" }, 4000); if (Array.isArray(list)) return list; } catch {}
      }
      return [
        { code: "P0420", desc: "Katalysator Wirkungsgrad (Bank 1) niedrig", sys: "Abgas & Emissionen", severity: "med", active: true },
        { code: "P0301", desc: "Zündaussetzer Zyl. 1", sys: "Motor", severity: "high", active: true },
      ];
    },

    async clearDtc(code) {
      if (S.dev) {
        try { const r = await send({ op: "clearDtc", code }, 4000); return !!(r?.ok ?? true); } catch { return false; }
      }
      await sleep(120); return true;
    },

    async clearAllDtc() {
      if (S.dev) {
        try { const r = await send({ op: "clearAllDtc" }, 4000); return !!(r?.ok ?? true); } catch { return false; }
      }
      await sleep(180); return true;
    },

    async readReadiness() {
      if (S.dev) {
        try {
          const bits = await send({ op: "readReadiness" }, 4000);
          if (bits && typeof bits === "object") {
            const sup = Array.isArray(bits.supported) ? bits.supported.filter(Number.isFinite) : [];
            const rd  = Array.isArray(bits.ready)     ? bits.ready.filter(Number.isFinite)     : [];
            return { supported: Array.from(new Set(sup)), ready: Array.from(new Set(rd)) };
          }
        } catch {}
      }
      return { supported: [0,1,2,3,4,5,6,7,8,9,10], ready: [0,1,2,3,5,6] };
    },

    async readFreezeFrame(code) {
      if (S.dev) {
        try { const ff = await send({ op: "readFreezeFrame", code }, 4000); if (ff && typeof ff === "object") return ff; } catch {}
      }
      const L = S.lastLive;
      const pick = (x, d) => (typeof x === "number" ? x : d);
      return {
        rpm: Math.round(pick(L.rpm, 1650)),
        speed: Math.round(pick(L.speed, 62)),
        coolant: Math.round(pick(L.coolant, 94)),
        iat: Math.round(pick(L.iat, 31)),
      };
    },

    async readMileageProbes() {
      if (S.dev) {
        try { const list = await send({ op: "readMileageProbes" }, 4000); if (Array.isArray(list)) return list; } catch {}
      }
      return [
        { source: "ECM (Motor)", km: 153240 },
        { source: "ABS/ESP", km: 153280 },
        { source: "BCM/Kombi", km: 153210 },
      ];
    },

    async writeActuator(name, payload) {
      if (S.dev) {
        try { const r = await send({ op: "writeActuator", name, payload }, 4000); return !!(r?.ok ?? true); } catch { return false; }
      }
      await sleep(120); return true;
    },
  };
}

// src/bridge/WebViewAdapterBridge.js
import React, { useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { BleManager } from "react-native-ble-plx";
import createDmRnAdapter from "../adapter/createDmRnAdapter";

function makeInjectedJS() {
  return `
(function () {
  if (window.__DM_BRIDGE__) return;
  const pending = new Map();
  window.__DM_BRIDGE__ = {
    call(method, args) {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        pending.set(id, { resolve, reject });
        window.ReactNativeWebView.postMessage(JSON.stringify({ id, type: "dmAdapter", method, args }));
      });
    },
    __resolve(id, ok, payload) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(payload) : p.reject(new Error(payload || "error"));
    }
  };
  const methods = [
    "connect","disconnect","isConnected",
    "startLive","stopLive","readLiveOnce",
    "getVehicle","readDTCs","clearDtc","clearAllDtc",
    "readReadiness","readFreezeFrame","readMileageProbes",
    "writeActuator"
  ];
  window.dmAdapter = {};
  for (const m of methods) {
    window.dmAdapter[m] = (...args) => window.__DM_BRIDGE__.call(m, args);
  }
})();`;
}

export default function WebViewAdapterBridge({ uri }) {
  const webRef = useRef(null);
  const injectedJavaScript = useMemo(() => makeInjectedJS(), []);

  // Nativer BLE-Adapter (gleiche API wie window.dmAdapter)
  const adapter = useMemo(() => {
    const ble = new BleManager();
    return createDmRnAdapter({ ble, targetName: /^DriveMind/i });
  }, []);

  function postResult(res) {
    const code =
      `window.__DM_BRIDGE__ && window.__DM_BRIDGE__.__resolve(${JSON.stringify(res.id)}, ${res.ok}, ${JSON.stringify(res.ok ? res.result : res.error)}); true;`;
    webRef.current?.injectJavaScript(code);
  }

  async function onMessage(e) {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (!data || data.type !== "dmAdapter") return;
      const { id, method, args } = data;
      const fn = adapter[method];
      if (typeof fn !== "function") {
        postResult({ id, ok: false, error: `unknown method ${method}` });
        return;
      }
      try {
        const result = await fn.apply(adapter, Array.isArray(args) ? args : []);
        postResult({ id, ok: true, result });
      } catch (err) {
        postResult({ id, ok: false, error: err?.message || String(err) });
      }
    } catch {
      // ignore
    }
  }

  return (
    <WebView
      ref={webRef}
      source={{ uri }}
      onMessage={onMessage}
      injectedJavaScript={injectedJavaScript}
      javaScriptEnabled
      domStorageEnabled
      originWhitelist={["*"]}
      allowsInlineMediaPlayback
    />
  );
}

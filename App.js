// App.js
import React from "react";
import { SafeAreaView, StatusBar } from "react-native";
import WebViewAdapterBridge from "./src/bridge/WebViewAdapterBridge";

// ⚠️ Setze hier die URL deiner laufenden Web-App (gleiche WLAN!)
// Beispiel: http://192.168.178.34:3000
const WEB_URL = "http://192.168.178.43:3000";

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0b0f1a" }}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0f1a" />
      <WebViewAdapterBridge uri={WEB_URL} />
    </SafeAreaView>
  );
}

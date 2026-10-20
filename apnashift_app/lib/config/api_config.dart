// API base URL — poori app me YEHI EK JAGAH se aata hai.
// Production URL (Railway) hataya gaya — koi URL hardcode nahi hota
// (D5: Railway wind-down ≈ Oct 2026; local MSSQL backend = default).
//
// Debug (flutter run): default http://10.0.2.2:3000 → Android emulator
//   bina flags ke local backend se connect karta hai.
//   Real phone (debug): --dart-define=API_BASE_URL=http://<laptop-LAN-IP>:3000
//   Tunnel se:          --dart-define=API_BASE_URL=https://<id>.trycloudflare.com
// Release: API_BASE_URL define ZAROORI hai — warna app fail-fast karta hai
//   (error code api_base_url_missing), galat/unknown URL par silently nahi jata.
//
// Android guard: localhost/127.0.0.1 = phone/emulator ka APNA loopback
// (backend kabhi usme nahi chalta) — common --dart-define galti ko
// emulator ke host-alias 10.0.2.2 me rewrite karke self-heal karte hain.
// Physical phone par 10.0.2.2 bhi nahi chalega — LAN-IP wala define hi sahi.
import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kDebugMode;

const String _envApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: kDebugMode ? 'http://10.0.2.2:3000' : '',
);

/// Runtime-resolved base URL (compile-time env + Android localhost guard).
final String apiBaseUrl = _resolveBaseUrl(_envApiBaseUrl);

String _resolveBaseUrl(String raw) {
  if (raw.isEmpty) return raw;
  if (defaultTargetPlatform != TargetPlatform.android) return raw;
  final uri = Uri.tryParse(raw);
  if (uri == null) return raw;
  final host = uri.host.toLowerCase();
  if (host == 'localhost' || host == '127.0.0.1') {
    return uri.replace(host: '10.0.2.2').toString();
  }
  return raw;
}

/// Emulator ke liye purana local URL (docs + error hints me use karo).
const String apiLocalEmulatorUrl = 'http://10.0.2.2:3000';

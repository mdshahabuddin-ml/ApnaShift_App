// API base URL — poori app me YEHI EK JAGAH se aata hai.
// Website parity: localhost/emulator -> local backend, else production.
// Override: flutter run --dart-define=API_BASE_URL=http://192.168.1.5:3000
// (real phone, same WiFi) ya staging URL.
// Default: production (real Android device par 10.0.2.2 kaam nahi karta —
// wo sirf Android emulator ka host-loopback hai).
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://apnashiftapp-production.up.railway.app',
);

/// Emulator ke liye purana local URL (docs + error hints me use karo).
const String apiLocalEmulatorUrl = 'http://10.0.2.2:3000';

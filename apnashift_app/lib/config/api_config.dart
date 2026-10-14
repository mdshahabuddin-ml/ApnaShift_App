// API base URL — poori app me YEHI EK JAGAH se aata hai.
// Default: Android emulator -> host PC ka localhost:3000.
// Override: flutter run --dart-define=API_BASE_URL=http://192.168.1.5:3000
// (real phone, same WiFi) ya production URL.
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3000',
);

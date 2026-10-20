import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

// Website parity persistence keys (same as web localStorage):
// apnashift-theme: system|light|dark (default system)
// apnashift-lang: en|hi (default en)
// apnashift-text-px: -4..+8 (default 0, step 2 — text-size.js parity)
// Storage: flutter_secure_storage (already in build — no new native plugin,
// avoids Kotlin/Gradle toolchain risk). Falls back to defaults on failure.
class AppSettings extends ChangeNotifier {
  static const themeKey = 'apnashift-theme';
  static const langKey = 'apnashift-lang';
  static const textPxKey = 'apnashift-text-px';

  final FlutterSecureStorage _store;

  AppSettings({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  /// Tests ke liye: bina platform channel ke, turant ready.
  AppSettings.test(
      {String theme = 'system', this._lang = 'en', this._textPx = 0})
      : _store = const FlutterSecureStorage(),
        _themeMode = theme,
        _ready = true;

  String _themeMode = 'system';
  String _lang = 'en';
  int _textPx = 0;
  bool _ready = false;

  String get themeMode => _themeMode;
  String get lang => _lang;
  int get textPx => _textPx;
  bool get ready => _ready;

  // text-size.js: body 16px base, delta added to key text.
  double get textDelta => _textPx.toDouble();

  Future<String?> _read(String key) {
    try {
      return _store.read(key: key).timeout(const Duration(seconds: 2));
    } catch (_) {
      return Future.value(null);
    }
  }

  Future<void> _write(String key, String value) {
    try {
      return _store.write(key: key, value: value).timeout(const Duration(seconds: 2));
    } catch (_) {
      return Future.value();
    }
  }

  Future<void> load() async {
    try {
      final t = await _read(themeKey);
      if (t == 'light' || t == 'dark' || t == 'system') _themeMode = t!;
      final l = await _read(langKey);
      if (l == 'hi' || l == 'en') _lang = l!;
      final pxRaw = await _read(textPxKey);
      final px = int.tryParse(pxRaw ?? '') ?? 0;
      if (px >= -4 && px <= 8) _textPx = px;
    } catch (_) {
      // locked device / test env — defaults par chalo.
    }
    _ready = true;
    notifyListeners();
  }

  Future<void> setTheme(String mode) async {
    if (mode != 'light' && mode != 'dark' && mode != 'system') mode = 'system';
    _themeMode = mode;
    notifyListeners();
    await _write(themeKey, mode);
  }

  Future<void> setLang(String lang) async {
    if (lang != 'hi' && lang != 'en') lang = 'en';
    _lang = lang;
    notifyListeners();
    await _write(langKey, lang);
  }

  Future<void> setTextPx(int px) async {
    if (px < -4) px = -4;
    if (px > 8) px = 8;
    _textPx = px;
    notifyListeners();
    await _write(textPxKey, '$px');
  }

  Future<void> bumpText(int by) => setTextPx(_textPx + by);
  Future<void> resetText() => setTextPx(0);
}

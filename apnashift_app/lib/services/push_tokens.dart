import 'dart:math';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/api_client.dart';

/// Push token registration — mirrors
/// POST/DELETE /api/notifications/device-tokens (Phase 2 push).
/// No Firebase here: app install ID is registered as the `android` token
/// so the backend has a real endpoint row per device. FCM delivery itself
/// needs server keys (FCM_PROJECT_ID/EMAIL/PRIVATE_KEY) — pending, in-app
/// rows stay source of truth (README parity). All best-effort, never throws.
class PushTokens {
  static const _key = 'apnashift_install_id';
  static const _store = FlutterSecureStorage();

  static Future<String> installId() async {
    try {
      final existing = await _store.read(key: _key);
      if (existing != null && existing.isNotEmpty) return existing;
      final id =
          'android-${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(999999)}';
      await _store.write(key: _key, value: id);
      return id;
    } catch (_) {
      return 'android-${DateTime.now().microsecondsSinceEpoch}';
    }
  }

  static Future<void> register(ApiClient api) async {
    try {
      final token = await installId();
      await api.post('/api/notifications/device-tokens',
          body: {'platform': 'android', 'token': token});
    } catch (_) {
      // best-effort — booking/login flows never block.
    }
  }

  static Future<void> unregister(ApiClient api) async {
    try {
      final token = await installId();
      await api.delete('/api/notifications/device-tokens',
          body: {'token': token});
    } catch (_) {
      // best-effort.
    }
  }
}

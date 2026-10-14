import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../api/auth_api.dart';
import '../models/app_user.dart';
import 'token_store.dart';

/// Session: token secure storage me, user memory me.
/// Restore: app start pe token -> GET /me (401 = logout).
class Session extends ChangeNotifier {
  final ApiClient api;
  late final AuthApi auth;
  final TokenStore _store;

  AppUser? user;
  bool ready = false;

  Session({ApiClient? client, TokenStore? store})
      : api = client ?? ApiClient(),
        _store = store ?? SecureTokenStore() {
    auth = AuthApi(api);
  }

  bool get loggedIn => user != null;

  Future<void> restore() async {
    try {
      final t = await _store.read();
      if (t != null && t.isNotEmpty) {
        api.setToken(t);
        try {
          user = await auth.me();
        } catch (_) {
          await logout(silent: true);
        }
      }
    } catch (_) {
      // Storage unavailable (locked device, test env) — start logged out.
      user = null;
    }
    ready = true;
    notifyListeners();
  }

  Future<String?> login({required String phone, required String password}) async {
    try {
      final r = await auth.login(phone: phone, password: password);
      api.setToken(r.token);
      await _store.write(r.token);
      user = r.user;
      notifyListeners();
      return null;
    } on ApiException catch (e) {
      return e.code;
    }
  }

  Future<String?> register({required String name, required String phone, required String password}) async {
    try {
      final r = await auth.register(name: name, phone: phone, password: password);
      api.setToken(r.token);
      await _store.write(r.token);
      user = r.user;
      notifyListeners();
      return null;
    } on ApiException catch (e) {
      return e.code;
    }
  }

  Future<void> logout({bool silent = false}) async {
    api.setToken(null);
    await _store.delete();
    user = null;
    if (!silent) notifyListeners();
  }
}

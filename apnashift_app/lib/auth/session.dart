import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../api/auth_api.dart';
import '../models/app_user.dart';
import '../services/push_tokens.dart';
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

  /// Returns null on success, else an error code for the UI.
  /// Codes: backend error codes, plus 'wrong_role' (driver/admin number —
  /// ye app customer-only hai) aur 'network_error' (server unreachable).
  /// Non-customer login ka token store NAHI hota (turant logout).
  Future<String?> login({required String phone, required String password}) async {
    try {
      final r = await auth.login(phone: phone, password: password);
      if (!r.user.isCustomer) {
        api.setToken(null);
        await _store.delete();
        user = null;
        notifyListeners();
        return 'wrong_role';
      }
      api.setToken(r.token);
      await _store.write(r.token);
      user = r.user;
      notifyListeners();
      PushTokens.register(api);
      return null;
    } on ApiException catch (e) {
      return e.code;
    } catch (_) {
      // SocketException / TimeoutException / storage errors — button atakna
      // nahi chahiye, isliye code me badlo (throw mat karo).
      return 'network_error';
    }
  }

  Future<String?> register({required String name, required String phone, required String password}) async {
    try {
      final r = await auth.register(name: name, phone: phone, password: password);
      api.setToken(r.token);
      await _store.write(r.token);
      user = r.user;
      notifyListeners();
      PushTokens.register(api);
      return null;
    } on ApiException catch (e) {
      return e.code;
    } catch (_) {
      return 'network_error';
    }
  }

  Future<void> logout({bool silent = false}) async {
    PushTokens.unregister(api);
    api.setToken(null);
    await _store.delete();
    user = null;
    if (!silent) notifyListeners();
  }
}

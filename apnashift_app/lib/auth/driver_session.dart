import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../api/driver_api.dart';
import '../models/driver.dart';
import '../services/push_tokens.dart';
import 'token_store.dart';

/// Driver session — website parity: separate token key
/// `apnashift_driver_token` (customer token untouched).
/// Login uses POST /api/auth/login (backend checks all three tables);
/// non-driver numbers return 'wrong_role'. Register uses
/// POST /api/drivers/register (returns token + application).
class DriverSession extends ChangeNotifier {
  final ApiClient api;
  late final DriverApi driver;
  final TokenStore _store;

  DriverUser? user;
  DriverApplication? application;
  bool ready = false;

  DriverSession({ApiClient? client, TokenStore? store})
      : api = client ?? ApiClient(),
        _store = store ??
            SecureTokenStore(
                storage: null, key: 'apnashift_driver_token') {
    driver = DriverApi(api);
  }

  /// Tests: no platform channel.
  DriverSession.test({ApiClient? client})
      : api = client ?? ApiClient(),
        _store = MemoryTokenStore() {
    driver = DriverApi(api);
    ready = true;
  }

  bool get loggedIn => user != null;

  Future<void> restore() async {
    try {
      final t = await _store.read();
      if (t != null && t.isNotEmpty) {
        api.setToken(t);
        try {
          final me = await driver.me();
          if (!me.isDriver) {
            await logout(silent: true);
          } else {
            user = me;
          }
        } catch (_) {
          await logout(silent: true);
        }
      }
    } catch (_) {
      user = null;
    }
    ready = true;
    notifyListeners();
  }

  /// null = success; else error code (backend code | wrong_role | network_error).
  Future<String?> login(
      {required String phone, required String password}) async {
    try {
      api.setToken(null);
      final d = await api.post('/api/auth/login',
          body: {'phone': phone, 'password': password});
      final u = DriverUser.fromJson(
          Map<String, dynamic>.from(d['user'] as Map));
      if (!u.isDriver) {
        await _store.delete();
        user = null;
        notifyListeners();
        return 'wrong_role';
      }
      final token = (d['token'] ?? '').toString();
      api.setToken(token);
      await _store.write(token);
      user = u;
      notifyListeners();
      PushTokens.register(api);
      return null;
    } on ApiException catch (e) {
      return e.code;
    } catch (_) {
      return 'network_error';
    }
  }

  Future<String?> register(Map<String, dynamic> fields) async {
    try {
      final r = await driver.register(fields);
      api.setToken(r.token);
      await _store.write(r.token);
      user = r.user;
      application = r.app;
      notifyListeners();
      PushTokens.register(api);
      return null;
    } on ApiException catch (e) {
      return e.code;
    } catch (_) {
      return 'network_error';
    }
  }

  Future<String?> saveUpi(String? upiId) async {
    try {
      final d = await driver.updateUpi(upiId);
      user = DriverUser.fromJson(d);
      notifyListeners();
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
    application = null;
    if (!silent) notifyListeners();
  }
}

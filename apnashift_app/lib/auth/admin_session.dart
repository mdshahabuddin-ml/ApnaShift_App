import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../api/admin_api.dart';
import 'token_store.dart';

/// Admin identity — POST /api/admin/login (admins table only).
/// Role comes from DB (admin | super_admin); both enter AdminHome.
/// Token key matches website: `apnashift_admin_token`.
class AdminUser {
  final String id;
  final String name;
  final String phone;
  final String role;

  const AdminUser(
      {required this.id,
      required this.name,
      required this.phone,
      required this.role});

  factory AdminUser.fromJson(Map<String, dynamic> j) => AdminUser(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        role: (j['role'] ?? 'admin').toString(),
      );

  bool get isStaff => role == 'admin' || role == 'super_admin';
  bool get isSuper => role == 'super_admin';
}

class AdminSession extends ChangeNotifier {
  final ApiClient api;
  late final AdminApi admin;
  final TokenStore _store;

  AdminUser? user;
  bool ready = false;

  AdminSession({ApiClient? client, TokenStore? store})
      : api = client ?? ApiClient(),
        _store = store ??
            SecureTokenStore(
                storage: null, key: 'apnashift_admin_token') {
    admin = AdminApi(api);
  }

  AdminSession.test({ApiClient? client})
      : api = client ?? ApiClient(),
        _store = MemoryTokenStore() {
    admin = AdminApi(api);
    ready = true;
  }

  bool get loggedIn => user != null;

  Future<void> restore() async {
    try {
      final t = await _store.read();
      if (t != null && t.isNotEmpty) {
        api.setToken(t);
        try {
          final d = await api.get('/api/auth/me');
          final u = AdminUser.fromJson(
              Map<String, dynamic>.from(d['user'] as Map));
          if (!u.isStaff) {
            await logout(silent: true);
          } else {
            user = u;
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

  /// null = success; else backend code | network_error.
  /// Both admin + super_admin enter (website admin-login.html parity —
  /// role comes from DB, never assumed).
  Future<String?> login(
      {required String phone, required String password}) async {
    try {
      final r = await admin.login(phone: phone, password: password);
      if (r.role != 'admin' && r.role != 'super_admin') {
        api.setToken(null);
        await _store.delete();
        user = null;
        notifyListeners();
        return 'not_staff';
      }
      api.setToken(r.token);
      await _store.write(r.token);
      // Name/phone round-trip via /me (login returns name only).
      try {
        final d = await api.get('/api/auth/me');
        user = AdminUser.fromJson(
            Map<String, dynamic>.from(d['user'] as Map));
      } catch (_) {
        user = AdminUser(
            id: '', name: r.name, phone: phone, role: r.role);
      }
      notifyListeners();
      return null;
    } on ApiException catch (e) {
      return e.code;
    } catch (_) {
      return 'network_error';
    }
  }

  Future<void> logout({bool silent = false}) async {
    api.setToken(null);
    await _store.delete();
    user = null;
    if (!silent) notifyListeners();
  }
}

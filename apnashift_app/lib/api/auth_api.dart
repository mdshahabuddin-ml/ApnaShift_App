import 'api_client.dart';
import '../models/app_user.dart';

/// POST /api/auth/* — register, login, me. Shapes backend docs ke hisaab se.
class AuthApi {
  final ApiClient _api;
  AuthApi(this._api);

  Future<({String token, AppUser user})> register({
    required String name,
    required String phone,
    required String password,
  }) async {
    final d = await _api.post('/api/auth/register', body: {'name': name, 'phone': phone, 'password': password});
    return (token: (d['token'] ?? '').toString(), user: AppUser.fromJson(d['user'] as Map<String, dynamic>));
  }

  Future<({String token, AppUser user})> login({required String phone, required String password}) async {
    final d = await _api.post('/api/auth/login', body: {'phone': phone, 'password': password});
    return (token: (d['token'] ?? '').toString(), user: AppUser.fromJson(d['user'] as Map<String, dynamic>));
  }

  Future<AppUser> me() async {
    final d = await _api.get('/api/auth/me');
    return AppUser.fromJson(d['user'] as Map<String, dynamic>);
  }
}

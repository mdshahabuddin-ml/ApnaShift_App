import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token persistence seam: production = secure storage, tests = memory.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> delete();
}

class SecureTokenStore implements TokenStore {
  final FlutterSecureStorage _s;
  final String key;
  SecureTokenStore({FlutterSecureStorage? storage, this.key = 'apnashift_token'})
      : _s = storage ?? const FlutterSecureStorage();

  @override
  Future<String?> read() => _s.read(key: key);
  @override
  Future<void> write(String token) => _s.write(key: key, value: token);
  @override
  Future<void> delete() => _s.delete(key: key);
}

class MemoryTokenStore implements TokenStore {
  String? _token;
  @override
  Future<String?> read() async => _token;
  @override
  Future<void> write(String token) async => _token = token;
  @override
  Future<void> delete() async => _token = null;
}

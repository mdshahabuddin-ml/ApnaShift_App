import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

/// Backend error (ok:false). [code] wahi string hai jo API bhejti hai
/// (jaise invalid_credentials, validation_failed, too_many_attempts).
class ApiException implements Exception {
  final String code;
  final int status;

  /// Backend ka friendly `message` field (jaise 423 maintenance ka
  /// block_message) — null jab body me na ho. Screens isi se user copy
  /// dikhati hain jab admin ne custom likha ho.
  final String? message;

  /// Poora JSON body (jab parse ho jaye) — 426 update_required me
  /// latest_version/update_url wagera isi se milte hain (dialog ko
  /// doosri fetch ki zaroorat nahi).
  final Map<String, dynamic>? details;
  ApiException(this.code, this.status, [this.message, this.details]);
  @override
  String toString() => 'ApiException($status): $code';
}

/// Thin JSON client: Bearer JWT, {ok:true} check, timeouts.
class ApiClient {
  /// Installed app version (semver x.y.z) — main.dart startup par
  /// PackageInfo se set hota hai. Server ko X-App-Version header me
  /// bheja jata hai (426 update_required gate). Empty = header skip
  /// (website parity, older binaries, unit tests).
  static String appVersion = '';

  /// 426 update_required aaye to UpdateCheckService yahan hook karta hai
  /// (global — har screen ke error paths me jaan-boojh kar touch nahi).
  static void Function(ApiException e)? onServerError;

  final http.Client _http;
  String? _token;

  ApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  void setToken(String? token) => _token = token;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
        if (appVersion.isNotEmpty) 'X-App-Version': appVersion,
      };

  /// Base URL missing (release build bina --dart-define=API_BASE_URL) —
  /// Uri.parse relative URL par aage confusing error deta hai, isliye
  /// yahin fail-fast: code api_base_url_missing screens par friendly hint.
  Uri _uri(String path) {
    if (apiBaseUrl.isEmpty) {
      throw ApiException('api_base_url_missing', 0);
    }
    return Uri.parse('$apiBaseUrl$path');
  }

  Future<Map<String, dynamic>> _decode(http.Response res) async {
    Map<String, dynamic>? body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      body = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300 || body == null || body['ok'] != true) {
      final e = ApiException(
        (body != null && body['error'] is String) ? body['error'] as String : 'http_${res.statusCode}',
        res.statusCode,
        (body != null && body['message'] is String) ? body['message'] as String : null,
        body,
      );
      if (res.statusCode == 426) onServerError?.call(e);
      throw e;
    }
    return body;
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async {
    final uri = _uri(path).replace(queryParameters: query);
    final res = await _http.get(uri, headers: _headers).timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> post(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .post(_uri(path),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> patch(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .patch(_uri(path),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> put(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .put(_uri(path),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> delete(String path, {Object? body}) async {
    final res = await _http
        .delete(_uri(path),
            headers: _headers, body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  /// SSE/live feeds ke liye raw streamed GET (Bearer header ke saath —
  /// website fetch-based SSE parity, EventSource nahi). Caller stream
  /// parse + cancel khud kare. Non-200 par ApiException.
  Future<http.StreamedResponse> getStreamed(String path,
      {Map<String, String>? query}) async {
    final uri = _uri(path).replace(queryParameters: query);
    final req = http.Request('GET', uri)..headers.addAll(_headers);
    req.headers['Accept'] = 'text/event-stream';
    final res = await _http.send(req).timeout(const Duration(seconds: 15));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException('http_${res.statusCode}', res.statusCode);
    }
    return res;
  }

  void close() => _http.close();
}

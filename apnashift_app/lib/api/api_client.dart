import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';

/// Backend error (ok:false). [code] wahi string hai jo API bhejti hai
/// (jaise invalid_credentials, validation_failed, too_many_attempts).
class ApiException implements Exception {
  final String code;
  final int status;
  ApiException(this.code, this.status);
  @override
  String toString() => 'ApiException($status): $code';
}

/// Thin JSON client: Bearer JWT, {ok:true} check, timeouts.
class ApiClient {
  final http.Client _http;
  String? _token;

  ApiClient({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  void setToken(String? token) => _token = token;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  Future<Map<String, dynamic>> _decode(http.Response res) async {
    Map<String, dynamic>? body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      body = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300 || body == null || body['ok'] != true) {
      throw ApiException(
        (body != null && body['error'] is String) ? body['error'] as String : 'http_${res.statusCode}',
        res.statusCode,
      );
    }
    return body;
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async {
    final uri = Uri.parse('$apiBaseUrl$path').replace(queryParameters: query);
    final res = await _http.get(uri, headers: _headers).timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> post(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .post(Uri.parse('$apiBaseUrl$path'),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> patch(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .patch(Uri.parse('$apiBaseUrl$path'),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> put(String path, {Object? body, Map<String, String>? headers}) async {
    final res = await _http
        .put(Uri.parse('$apiBaseUrl$path'),
            headers: {..._headers, ...?headers},
            body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  Future<Map<String, dynamic>> delete(String path, {Object? body}) async {
    final res = await _http
        .delete(Uri.parse('$apiBaseUrl$path'),
            headers: _headers, body: body == null ? null : jsonEncode(body))
        .timeout(const Duration(seconds: 15));
    return _decode(res);
  }

  /// SSE/live feeds ke liye raw streamed GET (Bearer header ke saath —
  /// website fetch-based SSE parity, EventSource nahi). Caller stream
  /// parse + cancel khud kare. Non-200 par ApiException.
  Future<http.StreamedResponse> getStreamed(String path,
      {Map<String, String>? query}) async {
    final uri = Uri.parse('$apiBaseUrl$path').replace(queryParameters: query);
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

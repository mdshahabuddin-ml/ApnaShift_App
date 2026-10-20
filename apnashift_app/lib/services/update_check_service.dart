import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';

/// App-update flow (GET /api/app-updates/latest + 426 update_required).
/// Singleton ChangeNotifier: main.dart startup + resume par checkNow()
/// call karta hai; pending payload par update dialog dikhata hai.
///   action=optional → dismissible (per-version, session memory)
///   action=required → blocking dialog (PopScope canPop:false); sirf
///                      "Update" button update_url kholta hai — app
///                      tab tak chal sakta hai, gate server-side hai.
/// Best-effort: network fail par kuch nahi, koi crash nahi.
class UpdateCheckService extends ChangeNotifier {
  UpdateCheckService._() : _api = ApiClient();

  /// Tests: MockClient wala ApiClient inject karke (singleton state se
  /// free — har test naya instance).
  @visibleForTesting
  UpdateCheckService.withApi(ApiClient client) : _api = client;

  static final UpdateCheckService instance = UpdateCheckService._();

  /// Automatic checks (startup/resume) itne time me ek baar — server par
  /// 60s cache bhi hai, dono milke spam nahi hone dete.
  static const throttle = Duration(hours: 6);

  final ApiClient _api;
  DateTime? _lastAutoCheck;
  bool _checking = false;
  Map<String, dynamic>? _pending;
  final Set<String> _dismissedVersions = {};

  Map<String, dynamic>? get pending => _pending;
  bool get checking => _checking;
  String get installedVersion => ApiClient.appVersion;

  /// main() se ek baar — 426 aaye to koi bhi screen ka API call
  /// dialog trigger kar dega (extra /latest fetch ki zaroorat nahi).
  void init() {
    ApiClient.onServerError = _onServerError;
  }

  void _onServerError(ApiException e) {
    if (e.code != 'update_required') return;
    final d = e.details ?? const <String, dynamic>{};
    _setPending({
      'action': 'required',
      'latest_version': d['latest_version'],
      'build': d['build'],
      'min_supported_version': d['min_supported_version'],
      'mandatory': true,
      'update_url': d['update_url'],
      'priority': d['priority'] ?? 'high',
      'release_notes': d['release_notes'] ?? '',
      'message': d['message'],
    });
  }

  /// Startup + app resume par. [force] retry button ke liye (throttle
  /// bypass). Idempotent: ek saath ek hi check.
  Future<void> checkNow({bool force = false}) async {
    if (_checking) return;
    if (!force &&
        _lastAutoCheck != null &&
        DateTime.now().difference(_lastAutoCheck!) < throttle) {
      return;
    }
    _checking = true;
    try {
      final d = await _api.get('/api/app-updates/latest', query: {
        if (ApiClient.appVersion.isNotEmpty) 'version': ApiClient.appVersion,
      });
      _lastAutoCheck = DateTime.now();
      final action = '${d['action'] ?? 'none'}';
      if (action != 'optional' && action != 'required') return;
      _setPending({
        'action': action,
        'latest_version': d['latest_version'],
        'build': d['build'],
        'min_supported_version': d['min_supported_version'],
        'mandatory': d['mandatory'] == true,
        'update_url': d['update_url'],
        'priority': d['priority'] ?? 'normal',
        'release_notes': d['release_notes'] ?? '',
        'message': null,
      });
    } catch (_) {
      // best-effort — next resume par dobara
    } finally {
      _checking = false;
    }
  }

  void _setPending(Map<String, dynamic> p) {
    final action = '${p['action']}';
    final version = '${p['latest_version']}';
    if (version.isEmpty || version == 'null') return;
    // Optional update ek baar "Baad me" — us version ke liye session me
    // dobara tang nahi. Required hamesha dobara aata hai (force).
    if (action == 'optional' && _dismissedVersions.contains(version)) return;
    if (action == 'required' &&
        _pending != null &&
        _pending!['action'] == 'required' &&
        _pending!['latest_version'] == version) {
      return; // already pending (426 + auto-check dono se aaya ho)
    }
    _pending = p;
    notifyListeners();
  }

  /// "Baad me" — optional ke liye. Required kabhi clear nahi hota.
  void dismissOptional() {
    if (_pending == null || _pending!['action'] == 'required') return;
    _dismissedVersions.add('${_pending!['latest_version']}');
    _pending = null;
    notifyListeners();
  }

  /// Dialog band hone par (required dialog sirf app kill se band hoga,
  /// par navigator pop kisi emergency me ho jaye to state saaf rahe).
  void clearPending() {
    _pending = null;
    notifyListeners();
  }

  Future<void> openUpdateUrl() async {
    final url = '${_pending?['update_url'] ?? ''}';
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication).catchError((_) {
      return false;
    });
  }
}

/// Update dialog — service.pending ko sunta hai. Required = blocking
/// (koi bahar ka raasta nahi), optional = "Baad me".
class AppUpdateDialog extends StatelessWidget {
  final UpdateCheckService service;
  const AppUpdateDialog({super.key, required this.service});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: service,
      builder: (context, _) {
        final p = service.pending;
        if (p == null) {
          // Required ke alawa pending khatam ho gaya to band.
          Navigator.of(context).maybePop();
          return const SizedBox.shrink();
        }
        final required = p['action'] == 'required';
        final latest = '${p['latest_version'] ?? ''}';
        final notes = '${p['release_notes'] ?? ''}';
        final message =
            '${p['message'] ?? ''}'.isNotEmpty
                ? '${p['message']}'
                : required
                    ? 'Ye version ab zaroori hai — bina update ke bookings nahi chalengi.'
                    : 'Naya version available hai.';
        return PopScope(
          canPop: !required,
          child: AlertDialog(
            title: Text(required
                ? 'Update zaroori hai ($latest)'
                : 'Naya version: $latest'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(message),
                  const SizedBox(height: 10),
                  if (notes.isNotEmpty)
                    Text(notes,
                        style: const TextStyle(fontSize: 13, color: Colors.black54)),
                  const SizedBox(height: 6),
                  Text(
                    'Installed: ${service.installedVersion.isEmpty ? '—' : service.installedVersion} → $latest',
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                ],
              ),
            ),
            actions: [
              if (!required)
                TextButton(
                  onPressed: () {
                    service.dismissOptional();
                    Navigator.of(context).maybePop();
                  },
                  child: const Text('Baad me'),
                ),
              ElevatedButton(
                onPressed: () async {
                  await service.openUpdateUrl();
                  if (!required && context.mounted) {
                    service.dismissOptional();
                    Navigator.of(context).maybePop();
                  }
                },
                child: const Text('Update karein'),
              ),
            ],
          ),
        );
      },
    );
  }
}

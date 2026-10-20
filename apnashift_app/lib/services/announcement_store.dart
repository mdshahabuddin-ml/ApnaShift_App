import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/api_client.dart';

/// Global announcement feed (GET /api/announcements/active) + maintenance
/// state. Singleton ChangeNotifier: AppScaffold banner har screen par isi
/// ko sunta hai; main.dart startup par load + refresh karta hai. Dismiss
/// per-id persist hota hai (flutter_secure_storage — koi naya plugin
/// nahi). Banner best-effort hai: network fail par purana state rehta hai.
class AnnouncementStore extends ChangeNotifier {
  AnnouncementStore._();
  static final AnnouncementStore instance = AnnouncementStore._();

  static const _dismissKey = 'apnashift-ann-dismissed';

  final ApiClient _api = ApiClient();
  final FlutterSecureStorage _store = const FlutterSecureStorage();

  List<Map<String, dynamic>> _items = const [];
  Map<String, dynamic> _maintenance = const {'blocked': false};
  String? _audience;
  bool _loaded = false;
  bool _refreshing = false;
  final Set<String> _dismissed = {};
  Timer? _ticker;

  List<Map<String, dynamic>> get items => _items;
  bool get loaded => _loaded;
  bool get refreshing => _refreshing;
  bool get maintenanceBlocked => _maintenance['blocked'] == true;
  String get maintenanceMessage =>
      (_maintenance['message'] ??
              'Maintenance in progress — bookings will resume shortly.')
          .toString();
  Set<String> get dismissed => Set.unmodifiable(_dismissed);

  /// Role change (login/logout) par audience badlo — change hote hi feed
  /// refresh hoti hai. null = anonymous (universal rows).
  void updateAudience(String? audience) {
    if (audience == _audience) return;
    _audience = audience;
    refresh();
  }

  /// Website announcements.js ke barabar: har 5 min par feed auto-refresh
  /// (bina page reload). Idempotent — dobara call karne par naya timer nahi.
  void startTicker() {
    _ticker ??= Timer.periodic(const Duration(minutes: 5), (_) => refresh());
  }

  void stopTicker() {
    _ticker?.cancel();
    _ticker = null;
  }

  Future<void> refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final d = await _api.get('/api/announcements/active', query: {
        'audience': ?_audience,
      });
      _items = [
        for (final x in (d['items'] as List? ?? const []))
          if (x is Map) Map<String, dynamic>.from(x),
      ];
      _maintenance = d['maintenance'] is Map
          ? Map<String, dynamic>.from(d['maintenance'] as Map)
          : const {'blocked': false};
      _loaded = true;
      notifyListeners();
    } catch (_) {
      // best-effort — purana state rehne do
    } finally {
      _refreshing = false;
    }
  }

  /// Abhi dikhne layak: show_banner + window (client clock, backend jaisi
  /// exclusive end) + per-id dismiss. maintenance_mode rows alag strip me
  /// aati hain (non-dismissible) — idhar se skip taaki duplicate na ho.
  List<Map<String, dynamic>> visibleItems() {
    final now = DateTime.now().toUtc();
    return _items.where((a) {
      if (a['show_banner'] == false) return false;
      if (a['maintenance_mode'] == true) return false;
      final id = '${a['id']}';
      if (_dismissed.contains(id)) return false;
      final s = a['start_at'] == null ? null : DateTime.tryParse('${a['start_at']}');
      final e = a['end_at'] == null ? null : DateTime.tryParse('${a['end_at']}');
      if (s != null && now.isBefore(s)) return false;
      if (e != null && !now.isBefore(e)) return false;
      return true;
    }).toList();
  }

  Future<void> dismiss(String id) async {
    if (!_dismissed.add(id)) return;
    notifyListeners();
    try {
      await _store
          .write(key: _dismissKey, value: jsonEncode(_dismissed.toList()))
          .timeout(const Duration(seconds: 2));
    } catch (_) {}
  }

  Future<void> loadDismissed() async {
    try {
      final raw = await _store.read(key: _dismissKey).timeout(const Duration(seconds: 2));
      final list = raw == null ? null : jsonDecode(raw);
      if (list is List) {
        _dismissed
          ..clear()
          ..addAll(list.map((x) => '$x'));
      }
      notifyListeners();
    } catch (_) {}
  }
}

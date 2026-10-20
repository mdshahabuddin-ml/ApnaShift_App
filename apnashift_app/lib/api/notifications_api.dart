import 'api_client.dart';

/// Bell + history — mirrors apnashift-backend/src/routes/notifications.js.
/// Owner-scoped (user/driver only); admin gets 403 by design.
class AppNotification {
  final String id;
  final String title;
  final String body;
  final String? bookingId;
  final String? type;
  final DateTime? createdAt;
  final bool read;

  const AppNotification({
    required this.id,
    required this.title,
    required this.body,
    this.bookingId,
    this.type,
    this.createdAt,
    this.read = false,
  });

  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
        id: (j['id'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        body: (j['body'] ?? '').toString(),
        bookingId: j['booking_id']?.toString(),
        type: j['type']?.toString(),
        createdAt: j['created_at'] == null
            ? null
            : DateTime.tryParse(j['created_at'].toString()),
        read: j['read_at'] != null || j['read'] == true,
      );
}

class NotificationsApi {
  final ApiClient _api;
  NotificationsApi(this._api);

  Future<List<AppNotification>> list({int limit = 20, String? before}) async {
    final d = await _api.get('/api/notifications', query: {
      'limit': '$limit',
      'before': ?before,
    });
    final raw = (d['items'] ?? d['notifications'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => AppNotification.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<int> unreadCount() async {
    final d = await _api.get('/api/notifications/unread-count');
    return int.tryParse('${d['unread'] ?? 0}') ?? 0;
  }

  Future<void> markRead(String id) async {
    await _api.patch('/api/notifications/$id/read');
  }

  Future<int> markAllRead() async {
    final d = await _api.post('/api/notifications/read-all');
    return int.tryParse('${d['updated'] ?? 0}') ?? 0;
  }
}

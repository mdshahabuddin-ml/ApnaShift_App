import 'dart:async';
import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../api/notifications_api.dart';
import '../auth/session.dart';
import '../services/sse.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'booking_detail_screen.dart';
import 'tracking_screen.dart';

/// Inbox — notifications.html parity: All/Unread chips, mark-all-read,
/// refresh, load more (before cursor), live SSE + 30s poll fallback.
/// Tap -> trip/tracking.
class NotificationsScreen extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  const NotificationsScreen(
      {super.key, required this.session, required this.settings});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  late final NotificationsApi _api = NotificationsApi(widget.session.api);
  List<AppNotification> _items = [];
  int _unread = 0;
  bool _unreadOnly = false;
  String? _error;
  bool _loading = true;
  bool _live = false;
  StreamSubscription<SseEvent>? _sse;
  Timer? _fallback;

  @override
  void initState() {
    super.initState();
    _load().then((_) {
      if (!mounted) return;
      // Live feed (missed rows replay via ?since=) + 30s poll fallback —
      // notifications.html stream + fallback parity.
      _sse = openSse(widget.session.api, '/api/notifications/stream',
              query: {
            'since': DateTime.now().toUtc().toIso8601String()
          }).listen((ev) {
        if (!mounted) return;
        setState(() => _live = true);
        if (ev.event == 'notification') _quietRefresh();
      });
      _fallback =
          Timer.periodic(const Duration(seconds: 30), (_) => _quietRefresh());
    });
  }

  @override
  void dispose() {
    _sse?.cancel();
    _fallback?.cancel();
    super.dispose();
  }

  /// Bina spinner flash ke refresh (SSE/poll driven).
  Future<void> _quietRefresh() async {
    if (!mounted || _loading) return;
    try {
      final items = await _api.list(limit: 20);
      final unread = await _api.unreadCount();
      if (!mounted) return;
      setState(() {
        _items = items;
        _unread = unread;
      });
    } catch (_) {
      // chup-chaap fail — manual refresh ab bhi hai.
    }
  }

  Future<void> _load({bool more = false}) async {
    if (!more) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      List<AppNotification> items;
      int unread;
      try {
        items = await _api.list(
            limit: 20,
            before: more && _items.isNotEmpty
                ? _items.last.createdAt?.toUtc().toIso8601String()
                : null);
      } on ApiException catch (e) {
        // Purana prod backend (notifications route nahi) -> 404 not_found.
        // Empty inbox dikhao, error mat do — bookings flow block nahi hona chahiye.
        if (e.code == 'not_found' || e.code == 'forbidden') {
          if (!mounted) return;
          setState(() {
            _items = more ? _items : [];
            _unread = 0;
            _loading = false;
          });
          return;
        }
        rethrow;
      }
      try {
        unread = await _api.unreadCount();
      } on ApiException catch (e) {
        if (e.code == 'not_found' || e.code == 'forbidden') {
          unread = 0;
        } else {
          rethrow;
        }
      }
      if (!mounted) return;
      setState(() {
        _items = more ? [..._items, ...items] : items;
        _unread = unread;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException
            ? 'Load fail (${e.code}). Retry karo.'
            : 'Server se baat nahi ho payi.';
        _loading = false;
      });
    }
  }

  Future<void> _markAll() async {
    try {
      await _api.markAllRead();
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException
              ? 'Mark fail (${e.code})'
              : 'Mark fail — retry karo.')));
    }
  }

  Future<void> _open(AppNotification n) async {
    try {
      await _api.markRead(n.id);
    } catch (_) {}
    if (!mounted) return;
    if (n.bookingId == null || n.bookingId!.isEmpty) {
      await _load();
      return;
    }
    final toTrack = (n.type == 'booking_accepted' ||
        n.type == 'assignment_received' ||
        n.type == 'driver_arrived' ||
        n.type == 'trip_started');
    Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => toTrack
            ? TrackingScreen(
                session: widget.session,
                settings: widget.settings,
                bookingId: n.bookingId!)
            : BookingDetailScreen(
                session: widget.session,
                settings: widget.settings,
                bookingId: n.bookingId!)));
  }

  @override
  Widget build(BuildContext context) {
    final shown =
        _unreadOnly ? _items.where((e) => !e.read).toList() : _items;
    return AppScaffold(
      settings: widget.settings,
      title: 'Notifications ($_unread)${_live ? ' • live' : ''}',
      actions: [
        IconButton(
            tooltip: 'Mark all read',
            icon: const Icon(Icons.done_all),
            onPressed: _markAll),
      ],
      body: RefreshIndicator(
        onRefresh: () => _load(),
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [
                    Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(_error!,
                            style: const TextStyle(color: Colors.red)))
                  ])
                : ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      Row(children: [
                        ChoiceChip(
                            label: const Text('All'),
                            selected: !_unreadOnly,
                            onSelected: (_) =>
                                setState(() => _unreadOnly = false)),
                        const SizedBox(width: 8),
                        ChoiceChip(
                            label: const Text('Unread'),
                            selected: _unreadOnly,
                            onSelected: (_) =>
                                setState(() => _unreadOnly = true)),
                      ]),
                      const SizedBox(height: 8),
                      if (shown.isEmpty)
                        const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text('Koi notification nahi.')),
                      ...shown.map((n) => Card(
                            child: ListTile(
                              title: Text(n.title,
                                  style: TextStyle(
                                      fontWeight: n.read
                                          ? FontWeight.w400
                                          : FontWeight.w800)),
                              subtitle: Text(
                                  '${n.body}\n${n.createdAt?.toString().split('.').first ?? ''}'),
                              isThreeLine: true,
                              trailing: n.bookingId == null
                                  ? null
                                  : const Icon(Icons.arrow_forward),
                              onTap: () => _open(n),
                            ),
                          )),
                      if (_items.isNotEmpty)
                        OutlinedButton(
                            onPressed: () => _load(more: true),
                            child: const Text('Load more')),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }
}

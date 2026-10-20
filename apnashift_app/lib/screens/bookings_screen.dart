import 'package:flutter/material.dart';
import '../api/api_client.dart';
import '../api/bookings_api.dart';
import '../auth/session.dart';
import '../models/booking.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'booking_detail_screen.dart';
import 'tracking_screen.dart';

/// My bookings — my-bookings.html + customer-dashboard history parity.
/// Paginated (Show more), status pill, tap -> detail, Track/Cancel actions.
/// Sirf customer (role=user) yahan aata hai — main.dart gate karta hai.
class BookingsScreen extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  final bool active;
  const BookingsScreen(
      {super.key,
      required this.session,
      required this.settings,
      this.active = true});

  @override
  State<BookingsScreen> createState() => _BookingsScreenState();
}

class _BookingsScreenState extends State<BookingsScreen> {
  late final BookingsApi _api = BookingsApi(widget.session.api);
  List<Booking> _items = [];
  int _total = 0;
  int _page = 1;
  static const _limit = 10;
  String? _error;
  bool _loading = true;
  bool _moreBusy = false;
  bool _actionBusy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant BookingsScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active && !_loading) _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
    });
    try {
      final r = await _api.list(page: 1, limit: _limit);
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _total = r.total;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _friendlyLoadError(e);
        _loading = false;
      });
    }
  }

  Future<void> _more() async {
    setState(() => _moreBusy = true);
    try {
      final r = await _api.list(page: _page + 1, limit: _limit);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _items = [..._items, ...r.items];
        _total = r.total;
        _moreBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _moreBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(_friendlyLoadError(e))));
    }
  }

  Future<void> _cancel(Booking b, String reason) async {
    setState(() => _actionBusy = true);
    try {
      final updated = await _api.cancel(b.id, reason);
      if (!mounted) return;
      setState(() {
        _items = _items.map((e) => e.id == updated.id ? updated : e).toList();
        _actionBusy = false;
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Booking cancelled.')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _actionBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException
              ? 'Cancel failed (${e.code})'
              : 'Cancel failed — try again.')));
    }
  }

  void _askCancel(Booking b) {
    String reason = cancelReasons.first;
    showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Cancel booking?'),
        content: DropdownButtonFormField<String>(
          initialValue: reason,
          items: cancelReasons
              .map((r) => DropdownMenuItem(value: r, child: Text(r)))
              .toList(),
          onChanged: (v) => reason = v ?? cancelReasons.first,
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c),
              child: const Text('Go back')),
          ElevatedButton(
              onPressed: () {
                Navigator.pop(c);
                _cancel(b, reason);
              },
              child: const Text('Yes, cancel')),
        ],
      ),
    );
  }

  void _openDetail(Booking b) {
    Navigator.of(context)
        .push(MaterialPageRoute(
            builder: (_) => BookingDetailScreen(
                session: widget.session,
                settings: widget.settings,
                bookingId: b.id)))
        .then((_) => _load());
  }

  void _openTrack(Booking b) {
    Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => TrackingScreen(
            session: widget.session,
            settings: widget.settings,
            bookingId: b.id)));
  }

  /// Raw exception ko user-friendly line me badlo.
  static String _friendlyLoadError(Object e) {
    if (e is ApiException) {
      switch (e.code) {
        case 'forbidden':
          return 'This login is not for customers (it is a driver/staff number). Log out and log in with a customer number.';
        case 'invalid_token':
        case 'missing_token':
          return 'Your session has expired — please log in again.';
        case 'too_many_attempts':
          return 'Too many requests — wait a moment and pull to refresh.';
        case 'maintenance_active':
          final m = e.message;
          return (m != null && m.isNotEmpty)
              ? 'Maintenance in progress — $m'
              : 'Maintenance in progress — bookings will resume shortly.';
        case 'api_base_url_missing':
          return 'API URL is not set — run with flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 (emulator) or http://<laptop-LAN-IP>:3000 (phone).';
        default:
          return 'Bookings could not be loaded (${e.code}). Pull to refresh.';
      }
    }
    return 'Unable to connect to the server. Check your network and the server, then pull to refresh.';
  }

  Widget _pill(String s) {
    Color c = Colors.grey;
    if (s == 'delivered') c = Colors.green;
    if (s == 'cancelled') c = Colors.red;
    if (s == 'in_transit' || s == 'arrived' || s == 'accepted') c = Colors.blue;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
          color: c.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(20)),
      child:
          Text(s, style: TextStyle(color: c, fontWeight: FontWeight.w700, fontSize: 12)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hasMore = _items.length < _total;
    return AppScaffold(
      settings: widget.settings,
      title: 'Hello, ${widget.session.user?.name ?? ''}',
      actions: [
        IconButton(
          tooltip: 'Logout',
          icon: const Icon(Icons.logout),
          onPressed: () => widget.session.logout(),
        ),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(_error!,
                              style: const TextStyle(color: Colors.red)),
                          const SizedBox(height: 16),
                          ElevatedButton(
                            onPressed: _load,
                            child: const Text('Retry ↻'),
                          ),
                          const SizedBox(height: 8),
                          OutlinedButton(
                            onPressed: () => widget.session.logout(),
                            child: const Text('Logout'),
                          ),
                        ],
                      ),
                    )
                  ])
                : _items.isEmpty
                    ? ListView(children: const [
                        Padding(
                            padding: EdgeInsets.all(24),
                            child: Text(
                                'No bookings yet — create your first booking from the Book tab.'))
                      ])
                    : ListView.builder(
                        itemCount: _items.length + 1,
                        itemBuilder: (c, i) {
                          if (i == _items.length) {
                            return Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(children: [
                                Text('Total $_total • showing ${_items.length}',
                                    style: const TextStyle(
                                        fontSize: 12, color: Colors.grey)),
                                if (hasMore)
                                  OutlinedButton(
                                      onPressed:
                                          _moreBusy ? null : _more,
                                  child: Text(_moreBusy
                                      ? 'Please wait…'
                                      : 'Show more')),
                              ]),
                            );
                          }
                          final b = _items[i];
                          return Card(
                            margin: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 6),
                            child: ListTile(
                              leading: const Icon(Icons.local_shipping),
                              title: Row(children: [
                                Expanded(
                                    child: Text(
                                        b.vehicleType,
                                        style: const TextStyle(
                                            fontWeight: FontWeight.w700))),
                                _pill(b.status),
                              ]),
                              subtitle: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                        '${b.pickupAddress ?? ''} → ${b.dropAddress ?? ''}'),
                                    if (b.priceRs != null)
                                      Text(
                                          '₹${b.priceRs!.toStringAsFixed(0)}',
                                          style: const TextStyle(
                                              fontWeight:
                                                  FontWeight.bold)),
                                    Row(children: [
                                      if (b.trackable)
                                        TextButton(
                                            onPressed: () =>
                                                _openTrack(b),
                                            child: const Text(
                                                'Track live')),
                                      if (b.cancellable)
                                        TextButton(
                                            onPressed: _actionBusy
                                                ? null
                                                : () =>
                                                    _askCancel(b),
                                            style: TextButton.styleFrom(
                                                foregroundColor:
                                                    Colors.red),
                                            child: const Text(
                                                'Cancel')),
                                    ]),
                                  ]),
                              onTap: () => _openDetail(b),
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}

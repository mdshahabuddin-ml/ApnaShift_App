import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api/api_client.dart';
import '../api/bookings_api.dart';
import '../auth/session.dart';
import '../models/booking.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'tracking_screen.dart';

/// Single trip — booking-detail.html parity: status badge, fare, payment
/// (UPI copy / Cash), driver (accepted+), cancel/dispute/rating actions.
class BookingDetailScreen extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  final String bookingId;
  const BookingDetailScreen(
      {super.key,
      required this.session,
      required this.settings,
      required this.bookingId});

  @override
  State<BookingDetailScreen> createState() => _BookingDetailScreenState();
}

class _BookingDetailScreenState extends State<BookingDetailScreen> {
  late final BookingsApi _api = BookingsApi(widget.session.api);
  Booking? _b;
  Map<String, dynamic>? _rating;
  String? _error;
  bool _loading = true;
  bool _busy = false;
  final _dispute = TextEditingController();
  int _stars = 0;
  final _comment = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _dispute.dispose();
    _comment.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final b = await _api.get(widget.bookingId);
      Map<String, dynamic>? r;
      if (b.rateable) {
        r = await _api.getRating(widget.bookingId);
      }
      if (!mounted) return;
      setState(() {
        _b = b;
        _rating = r;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException
            ? 'Load fail (${e.code}). Pull-to-refresh karo.'
            : 'Server se baat nahi ho payi.';
        _loading = false;
      });
    }
  }

  Future<void> _cancel(String reason) async {
    setState(() => _busy = true);
    try {
      final b = await _api.cancel(widget.bookingId, reason);
      if (!mounted) return;
      setState(() {
        _b = b;
        _busy = false;
      });
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Booking cancelled.')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException
              ? 'Cancel fail (${e.code})'
              : 'Cancel fail — retry karo.')));
    }
  }

  Future<void> _sendDispute() async {
    final reason = _dispute.text.trim();
    if (reason.length < 3) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Wajah kam se kam 3 akshar.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final b = await _api.dispute(widget.bookingId, reason);
      if (!mounted) return;
      setState(() {
        _b = b;
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Issue reported — admin dekhega.')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException
              ? 'Report fail (${e.code})'
              : 'Report fail — retry karo.')));
    }
  }

  Future<void> _rate() async {
    if (_stars < 1 || _stars > 5) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('1-5 stars chuno.')));
      return;
    }
    setState(() => _busy = true);
    try {
      final r = await _api.submitRating(
          widget.bookingId, _stars, _comment.text.trim());
      if (!mounted) return;
      setState(() {
        _rating = r;
        _busy = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Rating bhej di — dhanyavaad!')));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e is ApiException
              ? 'Rating fail (${e.code})'
              : 'Rating fail — retry karo.')));
    }
  }

  void _askCancel() {
    String reason = cancelReasons.first;
    showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Cancel booking?'),
        content: DropdownButtonFormField<String>(
          value: reason,
          items: cancelReasons
              .map((r) => DropdownMenuItem(value: r, child: Text(r)))
              .toList(),
          onChanged: (v) => reason = v ?? cancelReasons.first,
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c), child: const Text('Go back')),
          ElevatedButton(
              onPressed: () {
                Navigator.pop(c);
                _cancel(reason);
              },
              child: const Text('Yes, cancel')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Trip',
      body: RefreshIndicator(
        onRefresh: _load,
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
                    padding: const EdgeInsets.all(16),
                    children: [
                      _statusCard(),
                      _routeCard(),
                      _payCard(),
                      if (_b!.driver != null) _driverCard(),
                      _actions(),
                      _disputeCard(),
                      if (_b!.rateable) _ratingCard(),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }

  Widget _pill(String s) {
    Color c = Colors.grey;
    if (s == 'delivered') c = Colors.green;
    if (s == 'cancelled') c = Colors.red;
    if (s == 'in_transit' || s == 'arrived' || s == 'accepted') c = Colors.blue;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration:
          BoxDecoration(color: c.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(20)),
      child: Text(s,
          style: TextStyle(color: c, fontWeight: FontWeight.w800)),
    );
  }

  Widget _statusCard() => Card(
        child: ListTile(
          title: Text('Trip • ${_b!.vehicleType}',
              style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text(
              'Created ${_b!.createdAt?.toString().split('.').first ?? '—'}'),
          trailing: _pill(_b!.status),
        ),
      );

  Widget _routeCard() => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Pickup: ${_b!.pickupAddress ?? '—'}'),
                Text('Drop: ${_b!.dropAddress ?? '—'}'),
                if (_b!.distanceKm != null)
                  Text('Distance: ${_b!.distanceKm} km'),
                Text(
                    'Fare: ₹${_b!.priceRs?.toStringAsFixed(0) ?? '—'} (${_b!.paymentMethod})'),
                Text('Items: ${_b!.itemDescription?.isNotEmpty == true ? _b!.itemDescription! : '—'}'),
                if (_b!.status == 'cancelled' && _b!.cancelReason != null)
                  Text('Cancel: ${_b!.cancelReason} (${_b!.cancelledBy ?? ''})',
                      style: const TextStyle(color: Colors.red)),
                if (_b!.disputed)
                  Text('Disputed: ${_b!.disputeReason ?? ''}',
                      style: const TextStyle(color: Colors.orange)),
              ]),
        ),
      );

  Widget _payCard() {
    final upi = _b!.driver?.upiId;
    final isUpi = _b!.paymentMethod == 'upi';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Payment',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              Text(
                  'Method ${_b!.paymentMethod} • Status ${_b!.payment?.status ?? '—'}'),
              if (isUpi && upi != null) ...[
                const SizedBox(height: 6),
                Text(upi,
                    style: const TextStyle(
                        fontSize: 18, fontWeight: FontWeight.w800)),
                TextButton.icon(
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Copy UPI'),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: upi));
                    ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('UPI copied.')));
                  },
                ),
              ],
            ]),
      ),
    );
  }

  Widget _driverCard() => Card(
        child: ListTile(
          leading: const Icon(Icons.person),
          title: Text(_b!.driver!.name,
              style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
              '${_b!.driver!.vehicleType} • ${_b!.driver!.vehicleNumber}'),
        ),
      );

  Widget _actions() => Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          if (_b!.trackable)
            ElevatedButton(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => TrackingScreen(
                        session: widget.session,
                        settings: widget.settings,
                        bookingId: _b!.id))),
                child: const Text('Track live →')),
          if (_b!.cancellable)
            OutlinedButton(
                onPressed: _busy ? null : _askCancel,
                style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                child: const Text('Cancel Booking')),
        ],
      );

  Widget _disputeCard() => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Report an issue',
                    style: TextStyle(fontWeight: FontWeight.w800)),
                TextField(
                    controller: _dispute,
                    maxLength: 500,
                    decoration: const InputDecoration(
                        hintText: 'Wajah likho (min 3 akshar)',
                        border: OutlineInputBorder())),
                const SizedBox(height: 8),
                OutlinedButton(
                    onPressed: _busy ? null : _sendDispute,
                    child: const Text('Send')),
              ]),
        ),
      );

  Widget _ratingCard() {
    if (_rating != null) {
      return Card(
        child: ListTile(
          title: Text('★ ${_rating!['stars'] ?? ''} — rated',
              style: const TextStyle(fontWeight: FontWeight.w800)),
          subtitle: Text('${_rating!['comment'] ?? ''}'),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Rate trip',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              Row(
                children: List.generate(
                    5,
                    (i) => IconButton(
                        icon: Icon(Icons.star,
                            color: i < _stars
                                ? Colors.amber
                                : Colors.grey),
                        onPressed: () =>
                            setState(() => _stars = i + 1))),
              ),
              TextField(
                  controller: _comment,
                  maxLength: 500,
                  decoration: const InputDecoration(
                      hintText: 'Comment (optional)',
                      border: OutlineInputBorder())),
              const SizedBox(height: 8),
              ElevatedButton(
                  onPressed: _busy ? null : _rate,
                  child: const Text('Submit rating')),
            ]),
      ),
    );
  }
}

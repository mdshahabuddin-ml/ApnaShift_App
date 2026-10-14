import 'package:flutter/material.dart';
import '../api/bookings_api.dart';
import '../auth/session.dart';
import '../models/booking.dart';
import 'login_screen.dart';

/// Apni bookings (newest first) + logout. Driver/admin token yahan 403 dega.
class BookingsScreen extends StatefulWidget {
  final Session session;
  const BookingsScreen({super.key, required this.session});

  @override
  State<BookingsScreen> createState() => _BookingsScreenState();
}

class _BookingsScreenState extends State<BookingsScreen> {
  late final BookingsApi _api = BookingsApi(widget.session.api);
  List<Booking> _items = [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await _api.list();
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Namaste, ${widget.session.user?.name ?? ''}'),
        backgroundColor: navy,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => widget.session.logout(),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: const TextStyle(color: Colors.red)))])
                : _items.isEmpty
                    ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('Koi booking nahi — web se pehli booking banao.'))])
                    : ListView.builder(
                        itemCount: _items.length,
                        itemBuilder: (c, i) {
                          final b = _items[i];
                          return Card(
                            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                            child: ListTile(
                              leading: const Icon(Icons.local_shipping, color: navy),
                              title: Text('${b.vehicleType} • ${b.status}'),
                              subtitle: Text('${b.pickupAddress ?? ''} → ${b.dropAddress ?? ''}'),
                              trailing: b.priceRs == null ? null : Text('₹${b.priceRs!.toStringAsFixed(0)}', style: const TextStyle(fontWeight: FontWeight.bold)),
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}

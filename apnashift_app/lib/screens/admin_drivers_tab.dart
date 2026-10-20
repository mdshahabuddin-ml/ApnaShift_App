import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';

/// Drivers — admin-drivers.html queue parity: status filter
/// (pending/verified/review) + Verify/Reject/Deactivate/Reactivate +
/// password reset by driver row.
class AdminDriversTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminDriversTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminDriversTab> createState() => _AdminDriversTabState();
}

class _AdminDriversTabState extends State<AdminDriversTab> {
  String _status = 'pending';
  List<Map<String, dynamic>> _items = [];
  int _total = 0;
  int _page = 1;
  String? _error;
  bool _loading = true;
  bool _busy = false;
  final _pw = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _pw.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _page = 1;
    });
    try {
      final r = await widget.session.admin
          .drivers(status: _status, page: 1, limit: 20);
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _total = r.total;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = adminFriendly(e);
        _loading = false;
      });
    }
  }

  Future<void> _more() async {
    try {
      final r = await widget.session.admin
          .drivers(status: _status, page: _page + 1, limit: 20);
      if (!mounted) return;
      setState(() {
        _page += 1;
        _items = [..._items, ...r.items];
        _total = r.total;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _act(Future<void> Function() fn, String ok) async {
    setState(() => _busy = true);
    try {
      await fn();
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(ok)));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  void _askReject(Map<String, dynamic> d) {
    final c = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reject driver?'),
        content: TextField(
            controller: c,
            maxLength: 500,
            decoration: const InputDecoration(
                hintText: 'Reason (min 3 characters)',
                border: OutlineInputBorder())),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Back')),
          ElevatedButton(
              onPressed: () {
                final reason = c.text.trim();
                if (reason.length < 3) return;
                Navigator.pop(ctx);
                _act(
                    () => widget.session.admin
                        .rejectDriver('${d['id']}', reason),
                    'Rejected.');
              },
              child: const Text('Reject')),
        ],
      ),
    );
  }

  void _askResetPw(Map<String, dynamic> d) {
    _pw.clear();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Reset password — ${d['name'] ?? ''}'),
        content: TextField(
            controller: _pw,
            obscureText: true,
            decoration: const InputDecoration(
                hintText: 'New password (8+)',
                border: OutlineInputBorder())),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Back')),
          ElevatedButton(
              onPressed: () {
                if (_pw.text.length < 8) return;
                Navigator.pop(ctx);
                _act(
                    () => widget.session.admin.resetDriverPassword(
                        '${d['id']}', _pw.text),
                    'Password reset.');
              },
              child: const Text('Reset')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hasMore = _items.length < _total;
    return AppScaffold(
      settings: widget.settings,
      title: 'Drivers ($_total)',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
      ],
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: DropdownButtonFormField<String>(
            initialValue: _status,
            decoration: const InputDecoration(
                labelText: 'Status', border: OutlineInputBorder()),
            items: const [
              DropdownMenuItem(
                  value: 'pending', child: Text('pending')),
              DropdownMenuItem(
                  value: 'verified', child: Text('verified')),
              DropdownMenuItem(
                  value: 'review', child: Text('review (flagged)')),
            ],
            onChanged: (v) {
              if (v == null) return;
              setState(() => _status = v);
              _load();
            },
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? ListView(children: [adminErrorCard(_error!)])
                    : ListView.builder(
                        itemCount: _items.length + 1,
                        itemBuilder: (c, i) {
                          if (i == _items.length) {
                            return Padding(
                              padding: const EdgeInsets.all(12),
                              child: hasMore
                                  ? OutlinedButton(
                                      onPressed: _more,
                                      child:
                                          const Text('Show more'))
                                  : Text(
                                      'Total $_total • showing ${_items.length}',
                                      style: const TextStyle(
                                          fontSize: 12,
                                          color: Colors.grey)),
                            );
                          }
                          final d = _items[i];
                          return Card(
                            margin: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 6),
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    Row(children: [
                                      Expanded(
                                          child: Text(
                                              '${d['name'] ?? ''} • ${d['phone'] ?? ''}',
                                              style: const TextStyle(
                                                  fontWeight:
                                                      FontWeight.w800))),
                                      adminPill(
                                          (d['is_verified'] == true)
                                              ? 'verified'
                                              : ((d['rejection_reason'] !=
                                                      null)
                                                  ? 'REJECTED'
                                                  : 'pending')),
                                    ]),
                                    Text(
                                        '${d['vehicle_type'] ?? ''} • ${d['vehicle_number'] ?? ''}'),
                                    if (d['application_ref'] != null)
                                      Text(
                                          'Ref ${d['application_ref']}',
                                          style: const TextStyle(
                                              fontSize: 12,
                                              color: Colors.grey)),
                                    if (d['rejection_reason'] != null)
                                      Text(
                                          'Reject: ${d['rejection_reason']}',
                                          style: const TextStyle(
                                              color: Colors.red,
                                              fontSize: 12)),
                                    Wrap(spacing: 8, children: [
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _act(
                                                  () => widget
                                                      .session.admin
                                                      .verifyDriver(
                                                          '${d['id']}'),
                                                  'Verified.'),
                                          child:
                                              const Text('Verify')),
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () =>
                                                  _askReject(d),
                                          style: TextButton.styleFrom(
                                              foregroundColor:
                                                  Colors.red),
                                          child:
                                              const Text('Reject')),
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _act(
                                                  () => widget
                                                      .session.admin
                                                      .deactivateDriver(
                                                          '${d['id']}'),
                                                  'Deactivated.'),
                                          child: const Text(
                                              'Deactivate')),
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _act(
                                                  () => widget
                                                      .session.admin
                                                      .reactivateDriver(
                                                          '${d['id']}'),
                                                  'Reactivated.'),
                                          child: const Text(
                                              'Reactivate')),
                                      TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () =>
                                                  _askResetPw(d),
                                          child: const Text(
                                              'Reset PW')),
                                    ]),
                                  ]),
                            ),
                          );
                        },
                      ),
          ),
        ),
      ]),
    );
  }
}

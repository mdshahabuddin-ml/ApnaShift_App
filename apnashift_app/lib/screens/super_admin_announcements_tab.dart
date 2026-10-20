import 'package:flutter/material.dart';
import '../api/admin_api.dart';
import '../api/api_client.dart';
import 'admin_widgets.dart';

/// Super Admin â€¢ Announcements tab (super-admin.html parity).
/// CRUD + schedule + publish/deactivate + maintenance-mode block_message +
/// push report/retry/run. Bina FCM_* creds ke push "awaiting credentials"
/// dikhata hai (koi fake send nahi).
class SuperAdminAnnouncementsTab extends StatefulWidget {
  final ApiClient api;
  const SuperAdminAnnouncementsTab({super.key, required this.api});

  @override
  State<SuperAdminAnnouncementsTab> createState() =>
      _SuperAdminAnnouncementsTabState();
}

Color severityColor(String s) {
  switch (s) {
    case 'critical':
      return Colors.red;
    case 'maintenance':
      return Colors.deepOrange;
    case 'warning':
      return Colors.orange;
    default:
      return Colors.blue;
  }
}

/// ISO-8601 WITH offset (zod `datetime({offset:true})` requirement).
/// Dart local DateTime.toIso8601String() offset nahi lagata â€” yahan
/// timezone offset append hota hai (jaise +05:30).
String isoWithOffset(DateTime d) {
  final local = d.isUtc ? d.toLocal() : d;
  final off = local.timeZoneOffset;
  final sign = off.isNegative ? '-' : '+';
  final abs = off.abs();
  final hh = abs.inHours.toString().padLeft(2, '0');
  final mm = (abs.inMinutes % 60).toString().padLeft(2, '0');
  return '${local.toIso8601String()}$sign$hh:$mm';
}

String _shortTime(String? iso) {
  if (iso == null || iso.isEmpty) return 'open';
  return iso.split('T').length > 1
      ? '${iso.split('T').first} ${iso.split('T').last.substring(0, 5)}'
      : iso;
}

class _SuperAdminAnnouncementsTabState
    extends State<SuperAdminAnnouncementsTab> {
  late final AdminApi _admin = AdminApi(widget.api);
  List<Map<String, dynamic>> _items = [];
  int _total = 0;
  String _status = '';
  bool? _fcm;
  String? _error;
  bool _loading = true;
  bool _busy = false;

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
      final r = await _admin.announcements(
          status: _status.isEmpty ? null : _status, limit: 50);
      if (!mounted) return;
      setState(() {
        _items = r.items;
        _total = r.total;
        _fcm = r.fcmConfigured;
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

  Future<void> _patch(String id, Map<String, dynamic> body) async {
    setState(() => _busy = true);
    try {
      await _admin.updateAnnouncement(id, body);
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _runPush(String id) async {
    setState(() => _busy = true);
    try {
      final r = await _admin.runAnnouncementPush(id);
      if (!mounted) return;
      setState(() => _busy = false);
      final sk = r['dispatch'] is Map ? (r['dispatch'] as Map)['skipped'] : null;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(sk != null
              ? 'Push run nahi (credentials awaiting).'
              : 'Push dispatch chala.')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _pushReport(Map<String, dynamic> a) async {
    try {
      final r = await _admin.announcementPushReport('${a['id']}');
      if (!mounted) return;
      final counts = (r['counts'] ?? {}) as Map;
      final counters = (r['counters'] ?? {}) as Map;
      final recent = ((r['recent'] ?? []) as List).whereType<Map>().toList();
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Push report'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView(
              shrinkWrap: true,
              children: [
                Text('FCM: ${r['fcm_configured'] == true ? 'ready' : 'awaiting credentials'}',
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                Text('Status: ${r['push_status'] ?? 'â€”'}'),
                Text(
                    'Total / delivered / failed: ${counters['total'] ?? 0} / ${counters['delivered'] ?? 0} / ${counters['failed'] ?? 0}'),
                Text(
                    'Log: sent ${counts['sent'] ?? 0} â€¢ failed ${counts['failed'] ?? 0} â€¢ pending ${counts['pending'] ?? 0}'),
                const SizedBox(height: 8),
                ...recent.map((x) => Text(
                    'â€¢ ${x['owner_role']} ${x['status']}${x['error'] != null ? ' (${x['error']})' : ''}',
                    style: const TextStyle(fontSize: 12))),
              ],
            ),
          ),
          actions: [
            if (r['fcm_configured'] == true)
              TextButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _runPush('${a['id']}');
                },
                child: const Text('Run now'),
              ),
            TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Close')),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _form([Map<String, dynamic>? existing]) async {
    final e = existing;
    final title = TextEditingController(text: '${e?['title'] ?? ''}');
    final body = TextEditingController(text: '${e?['body'] ?? ''}');
    final blockMsg = TextEditingController(text: '${e?['block_message'] ?? ''}');
    final pushBody = TextEditingController(
        text: '${e?['push_body'] ?? ''}');
    final nbm = TextEditingController(
        text: e?['notify_before_minutes'] == null
            ? ''
            : '${e!['notify_before_minutes']}');
    String severity = '${e?['severity'] ?? 'info'}';
    String audience = '${e?['audience'] ?? 'all'}';
    String status = '${e?['status'] ?? 'draft'}';
    bool maintenance = e?['maintenance_mode'] == true;
    bool pushEnabled = e?['push'] is Map && (e!['push'] as Map)['enabled'] == true;
    DateTime? start =
        e?['start_at'] != null ? DateTime.tryParse('${e!['start_at']}') : null;
    DateTime? end =
        e?['end_at'] != null ? DateTime.tryParse('${e!['end_at']}') : null;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) => AlertDialog(
          title: Text(e == null ? 'New announcement' : 'Edit announcement'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView(
              shrinkWrap: true,
              children: [
                TextField(
                    controller: title,
                    decoration: const InputDecoration(
                        labelText: 'Title *', border: OutlineInputBorder())),
                const SizedBox(height: 8),
                TextField(
                    controller: body,
                    maxLines: 3,
                    decoration: const InputDecoration(
                        labelText: 'Body *', border: OutlineInputBorder())),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: severity,
                  decoration: const InputDecoration(
                      labelText: 'Severity', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'info', child: Text('info')),
                    DropdownMenuItem(value: 'warning', child: Text('warning')),
                    DropdownMenuItem(
                        value: 'critical', child: Text('critical')),
                    DropdownMenuItem(
                        value: 'maintenance', child: Text('maintenance')),
                  ],
                  onChanged: (v) => setD(() => severity = v ?? 'info'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: audience,
                  decoration: const InputDecoration(
                      labelText: 'Audience', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'all', child: Text('all')),
                    DropdownMenuItem(value: 'users', child: Text('users')),
                    DropdownMenuItem(value: 'drivers', child: Text('drivers')),
                  ],
                  onChanged: (v) => setD(() => audience = v ?? 'all'),
                ),
                if (e == null)
                  DropdownButtonFormField<String>(
                    initialValue: status,
                    decoration: const InputDecoration(
                        labelText: 'Status', border: OutlineInputBorder()),
                    items: const [
                      DropdownMenuItem(value: 'draft', child: Text('draft')),
                      DropdownMenuItem(
                          value: 'published', child: Text('published')),
                    ],
                    onChanged: (v) => setD(() => status = v ?? 'draft'),
                  ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Maintenance mode (blocks bookings)'),
                  value: maintenance,
                  onChanged: (v) => setD(() => maintenance = v),
                ),
                if (maintenance)
                  TextField(
                      controller: blockMsg,
                      maxLength: 500,
                      decoration: const InputDecoration(
                          labelText: 'Block message * (users ko dikhega)',
                          border: OutlineInputBorder())),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Push (FCM) enabled'),
                  value: pushEnabled,
                  onChanged: (v) => setD(() => pushEnabled = v),
                ),
                Row(children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () async {
                        final d = await _pickDateTime(ctx, start);
                        if (d != null) setD(() => start = d);
                      },
                      child: Text(
                          'Start: ${start == null ? 'none' : _shortTime(isoWithOffset(start!))}'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () async {
                        final d = await _pickDateTime(ctx, end);
                        if (d != null) setD(() => end = d);
                      },
                      child: Text(
                          'End: ${end == null ? 'none' : _shortTime(isoWithOffset(end!))}'),
                    ),
                  ),
                ]),
                if (start != null || end != null)
                  TextButton(
                    onPressed: () => setD(() {
                      start = null;
                      end = null;
                    }),
                    child: const Text('Clear window (open-ended)'),
                  ),
                TextField(
                    controller: nbm,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: false),
                    decoration: const InputDecoration(
                        labelText:
                            'Notify before start (min, blank = off)',
                        helperText:
                            'Push = start − N min (explicit time wins)',
                        border: OutlineInputBorder())),
                if (pushBody.text.isNotEmpty || pushEnabled)
                  TextField(
                      controller: pushBody,
                      maxLength: 500,
                      decoration: const InputDecoration(
                          labelText: 'Push body (optional â€” body use hogi)',
                          border: OutlineInputBorder())),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Back')),
            ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Save')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    if (!mounted) return;
    if (title.text.trim().isEmpty || body.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Title aur body zaroori hain.')));
      return;
    }
    if (maintenance && blockMsg.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Maintenance ke liye block message zaroori hai.')));
      return;
    }
    final nbmRaw = nbm.text.trim();
    int? nbmVal;
    if (nbmRaw.isNotEmpty) {
      nbmVal = int.tryParse(nbmRaw);
      if (nbmVal == null || nbmVal < 0 || nbmVal > 10080) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Notify minutes 0-10080 hone chahiye.')));
        return;
      }
    }
    final payload = <String, dynamic>{
      'title': title.text.trim(),
      'body': body.text.trim(),
      'severity': severity,
      'audience': audience,
      'maintenance_mode': maintenance,
      if (maintenance) 'block_message': blockMsg.text.trim(),
      'push_enabled': pushEnabled,
      if (pushBody.text.trim().isNotEmpty) 'push_body': pushBody.text.trim(),
      if (start != null) 'start_at': isoWithOffset(start!),
      if (end != null) 'end_at': isoWithOffset(end!),
      if (nbmVal != null)
        'notify_before_minutes': nbmVal
      else if (e != null)
        'notify_before_minutes': null,
      if (e == null) 'status': status,
    };
    setState(() => _busy = true);
    try {
      if (e == null) {
        await _admin.createAnnouncement(payload);
      } else {
        await _admin.updateAnnouncement('${e['id']}', payload);
      }
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (err) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(err))));
    }
  }

  static Future<DateTime?> _pickDateTime(
      BuildContext ctx, DateTime? current) async {
    final d = await showDatePicker(
        context: ctx,
        initialDate: current ?? DateTime.now(),
        firstDate: DateTime(2024),
        lastDate: DateTime(2100));
    if (d == null || !ctx.mounted) return null;
    final t = await showTimePicker(
        context: ctx, initialTime: TimeOfDay.fromDateTime(current ?? DateTime.now()));
    if (t == null) return null;
    return DateTime(d.year, d.month, d.day, t.hour, t.minute);
  }

  Widget _statusChip(Map<String, dynamic> a) {
    final st = '${a['status']}';
    final color = st == 'published'
        ? Colors.green
        : st == 'deactivated'
            ? Colors.grey
            : Colors.blueGrey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color)),
      child: Text(st,
          style:
              TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final fcmOk = _fcm == true;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
        child: Row(children: [
          const Text('Filter: ',
              style: TextStyle(fontWeight: FontWeight.w700)),
          DropdownButton<String>(
            value: _status,
            items: const [
              DropdownMenuItem(value: '', child: Text('all')),
              DropdownMenuItem(value: 'draft', child: Text('draft')),
              DropdownMenuItem(value: 'published', child: Text('published')),
              DropdownMenuItem(
                  value: 'deactivated', child: Text('deactivated')),
            ],
            onChanged: (v) => setState(() => _status = v ?? ''),
          ),
          const Spacer(),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _form(),
            icon: const Icon(Icons.add, size: 16),
            label: const Text('New'),
          ),
          const SizedBox(width: 8),
          Chip(
            avatar: Icon(
                fcmOk ? Icons.notifications_active : Icons.notifications_off,
                size: 16,
                color: fcmOk ? Colors.green : Colors.orange),
            label: Text(fcmOk ? 'FCM ready' : 'FCM awaiting creds',
                style: const TextStyle(fontSize: 11)),
          ),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _error != null
                  ? ListView(children: [adminErrorCard(_error!)])
                  : _items.isEmpty
                      ? ListView(children: const [
                          SizedBox(height: 80),
                          Center(child: Text('Koi announcement nahi.')),
                        ])
                      : ListView.builder(
                          itemCount: _items.length + 1,
                          itemBuilder: (c, i) {
                            if (i == _items.length) {
                              return Padding(
                                padding: const EdgeInsets.all(12),
                                child: Text('Total $_total â€¢ showing ${_items.length}',
                                    style: const TextStyle(
                                        fontSize: 12, color: Colors.grey)),
                              );
                            }
                            final a = _items[i];
                            final push = (a['push'] ?? {}) as Map;
                            final sev = '${a['severity']}';
                            return Card(
                              margin: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 4),
                              child: Padding(
                                padding: const EdgeInsets.all(10),
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    Row(children: [
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 6, vertical: 2),
                                        decoration: BoxDecoration(
                                            color: severityColor(sev)
                                                .withValues(alpha: 0.15),
                                            borderRadius:
                                                BorderRadius.circular(8)),
                                        child: Text(sev,
                                            style: TextStyle(
                                                color: severityColor(sev),
                                                fontSize: 11,
                                                fontWeight:
                                                    FontWeight.w700)),
                                      ),
                                      const SizedBox(width: 6),
                                      Text('${a['audience']}',
                                          style: const TextStyle(
                                              fontSize: 11,
                                              color: Colors.grey)),
                                      const SizedBox(width: 6),
                                      if (a['maintenance_mode'] == true)
                                        const Icon(Icons.build,
                                            size: 14,
                                            color: Colors.deepOrange),
                                      const Spacer(),
                                      _statusChip(a),
                                    ]),
                                    const SizedBox(height: 4),
                                    Text('${a['title']}',
                                        style: const TextStyle(
                                            fontWeight: FontWeight.w800)),
                                    Text('${a['body']}',
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 13)),
                                    Text(
                                        'Window: ${_shortTime(a['start_at'])} â†’ ${_shortTime(a['end_at'])}',
                                        style: const TextStyle(
                                            fontSize: 11, color: Colors.grey)),
                                    if (a['maintenance_mode'] == true)
                                      Text(
                                          'Block: ${a['block_message'] ?? 'â€”'}',
                                          style: const TextStyle(
                                              fontSize: 12,
                                              color: Colors.deepOrange)),
                                    Text(
                                        'Push: ${push['status'] ?? 'none'} â€¢ sent ${push['delivered'] ?? 0}/${push['total'] ?? 0} â€¢ failed ${push['failed'] ?? 0}',
                                        style: const TextStyle(
                                            fontSize: 11, color: Colors.grey)),
                                    Wrap(spacing: 4, children: [
                                      if (a['status'] != 'published')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${a['id']}',
                                                  {'status': 'published'}),
                                          child: const Text('Publish'),
                                        ),
                                      if (a['status'] == 'published')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${a['id']}',
                                                  {'status': 'deactivated'}),
                                          child: const Text('Deactivate'),
                                        ),
                                      if (push['status'] == 'failed')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${a['id']}',
                                                  {'retry_push': true}),
                                          child: const Text('Retry push'),
                                        ),
                                      TextButton(
                                        onPressed: () => _pushReport(a),
                                        child: const Text('Push report'),
                                      ),
                                      TextButton(
                                        onPressed: _busy
                                            ? null
                                            : () => _form(a),
                                        child: const Text('Edit'),
                                      ),
                                    ]),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
        ),
      ),
    ]);
  }
}


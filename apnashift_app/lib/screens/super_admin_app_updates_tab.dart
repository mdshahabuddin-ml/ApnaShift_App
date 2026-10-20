import 'package:flutter/material.dart';
import '../api/admin_api.dart';
import '../api/api_client.dart';
import 'admin_widgets.dart';

/// Super Admin • App updates tab (super-admin.html parity).
/// App releases CRUD + publish/archive + push report/retry/run. Bina
/// FCM_* creds ke push "awaiting credentials" dikhata hai (koi fake
/// send nahi). update_url sirf https (backend validate karta hai).
class SuperAdminAppUpdatesTab extends StatefulWidget {
  final ApiClient api;
  const SuperAdminAppUpdatesTab({super.key, required this.api});

  @override
  State<SuperAdminAppUpdatesTab> createState() =>
      _SuperAdminAppUpdatesTabState();
}

class _SuperAdminAppUpdatesTabState extends State<SuperAdminAppUpdatesTab> {
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
      final r = await _admin.appReleases(
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
      await _admin.updateAppRelease(id, body);
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
      final r = await _admin.runAppReleasePush(id);
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

  Future<void> _pushReport(Map<String, dynamic> rel) async {
    try {
      final r = await _admin.appReleasePushReport('${rel['id']}');
      if (!mounted) return;
      final counts = (r['counts'] ?? {}) as Map;
      final counters = (r['counters'] ?? {}) as Map;
      final recent = ((r['recent'] ?? []) as List).whereType<Map>().toList();
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('Push report — v${rel['version']}'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView(
              shrinkWrap: true,
              children: [
                Text(
                    'FCM: ${r['fcm_configured'] == true ? 'ready' : 'awaiting credentials'}',
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                Text('Status: ${r['push_status'] ?? '—'}'),
                Text(
                    'Total / delivered / failed: ${counters['total'] ?? 0} / ${counters['delivered'] ?? 0} / ${counters['failed'] ?? 0}'),
                Text(
                    'Log: sent ${counts['sent'] ?? 0} • failed ${counts['failed'] ?? 0} • pending ${counts['pending'] ?? 0}'),
                const SizedBox(height: 8),
                ...recent.map((x) => Text(
                    '• ${x['owner_role']} ${x['status']}${x['error'] != null ? ' (${x['error']})' : ''}',
                    style: const TextStyle(fontSize: 12))),
              ],
            ),
          ),
          actions: [
            if (r['fcm_configured'] == true)
              TextButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _runPush('${rel['id']}');
                },
                child: const Text('Run now'),
              ),
            TextButton(
                onPressed: () => Navigator.pop(ctx), child: const Text('Close')),
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
    final version = TextEditingController(text: '${e?['version'] ?? ''}');
    final build = TextEditingController(
        text: e?['build'] == null ? '' : '${e!['build']}');
    final minVer = TextEditingController(
        text: '${e?['min_supported_version'] ?? ''}');
    final notes = TextEditingController(text: '${e?['release_notes'] ?? ''}');
    final url = TextEditingController(text: '${e?['update_url'] ?? ''}');
    final pushTitle =
        TextEditingController(text: '${e?['push'] is Map ? (e!['push'] as Map)['title'] ?? '' : ''}');
    final pushBody =
        TextEditingController(text: '${e?['push'] is Map ? (e!['push'] as Map)['body'] ?? '' : ''}');
    bool mandatory = e?['mandatory'] == true;
    String audience = '${e?['audience'] ?? 'all'}';
    String priority = '${e?['priority'] ?? 'normal'}';
    String status = '${e?['status'] ?? 'draft'}';
    bool pushEnabled = e?['push'] is Map && (e!['push'] as Map)['enabled'] == true;

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) => AlertDialog(
          title: Text(e == null ? 'New app release' : 'Edit release'),
          content: SizedBox(
            width: double.maxFinite,
            child: ListView(
              shrinkWrap: true,
              children: [
                TextField(
                    controller: version,
                    decoration: const InputDecoration(
                        labelText: 'Version * (x.y.z)',
                        helperText: 'pubspec versionName jaisa — e.g. 1.1.0',
                        border: OutlineInputBorder())),
                const SizedBox(height: 8),
                TextField(
                    controller: build,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: false),
                    decoration: const InputDecoration(
                        labelText: 'Build (versionCode, optional)',
                        border: OutlineInputBorder())),
                const SizedBox(height: 8),
                TextField(
                    controller: minVer,
                    decoration: const InputDecoration(
                        labelText: 'Min supported version (optional)',
                        helperText: 'Is se purane install = forced update',
                        border: OutlineInputBorder())),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Mandatory update'),
                  subtitle: const Text(
                      'Purane versions bookings nahi kar payenge (426)'),
                  value: mandatory,
                  onChanged: (v) => setD(() => mandatory = v),
                ),
                Row(children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: audience,
                      decoration: const InputDecoration(
                          labelText: 'Audience', border: OutlineInputBorder()),
                      items: const [
                        DropdownMenuItem(value: 'all', child: Text('all')),
                        DropdownMenuItem(value: 'users', child: Text('users')),
                        DropdownMenuItem(
                            value: 'drivers', child: Text('drivers')),
                      ],
                      onChanged: (v) => setD(() => audience = v ?? 'all'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: priority,
                      decoration: const InputDecoration(
                          labelText: 'Priority', border: OutlineInputBorder()),
                      items: const [
                        DropdownMenuItem(value: 'low', child: Text('low')),
                        DropdownMenuItem(value: 'normal', child: Text('normal')),
                        DropdownMenuItem(value: 'high', child: Text('high')),
                      ],
                      onChanged: (v) => setD(() => priority = v ?? 'normal'),
                    ),
                  ),
                ]),
                const SizedBox(height: 8),
                TextField(
                    controller: notes,
                    maxLines: 4,
                    maxLength: 8000,
                    decoration: const InputDecoration(
                        labelText: 'Release notes *',
                        helperText: 'Dialog me users ko yahi dikhega',
                        border: OutlineInputBorder())),
                TextField(
                    controller: url,
                    maxLength: 500,
                    decoration: const InputDecoration(
                        labelText: 'Update URL (https://…)',
                        helperText:
                            'Play Store listing / verified APK page — sirf https',
                        border: OutlineInputBorder())),
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
                  title: const Text('Push (FCM) release notice'),
                  value: pushEnabled,
                  onChanged: (v) => setD(() => pushEnabled = v),
                ),
                if (pushEnabled) ...[
                  TextField(
                      controller: pushTitle,
                      maxLength: 200,
                      decoration: const InputDecoration(
                          labelText: 'Push title (optional)',
                          border: OutlineInputBorder())),
                  TextField(
                      controller: pushBody,
                      maxLength: 500,
                      decoration: const InputDecoration(
                          labelText: 'Push body (optional)',
                          border: OutlineInputBorder())),
                ],
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
    if (version.text.trim().isEmpty || notes.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Version aur release notes zaroori hain.')));
      return;
    }
    if (!RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version.text.trim())) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Version x.y.z format me ho (e.g. 1.1.0).')));
      return;
    }
    final minTrim = minVer.text.trim();
    if (minTrim.isNotEmpty &&
        !RegExp(r'^\d+\.\d+\.\d+$').hasMatch(minTrim)) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Min supported version bhi x.y.z me ho.')));
      return;
    }
    final urlTrim = url.text.trim();
    if (urlTrim.isNotEmpty && !urlTrim.startsWith('https://')) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Update URL https:// se shuru hona chahiye.')));
      return;
    }
    final buildRaw = build.text.trim();
    int? buildVal;
    if (buildRaw.isNotEmpty) {
      buildVal = int.tryParse(buildRaw);
      if (buildVal == null || buildVal < 1) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Build positive integer ho.')));
        return;
      }
    }
    final payload = <String, dynamic>{
      'version': version.text.trim(),
      'build': ?buildVal,
      if (minTrim.isNotEmpty)
        'min_supported_version': minTrim
      else if (e != null)
        'min_supported_version': null,
      'mandatory': mandatory,
      'audience': audience,
      'priority': priority,
      'release_notes': notes.text.trim(),
      if (urlTrim.isNotEmpty)
        'update_url': urlTrim
      else if (e != null)
        'update_url': null,
      'push_enabled': pushEnabled,
      if (pushTitle.text.trim().isNotEmpty)
        'push_title': pushTitle.text.trim(),
      if (pushBody.text.trim().isNotEmpty)
        'push_body': pushBody.text.trim(),
      if (e == null) 'status': status,
    };
    setState(() => _busy = true);
    try {
      if (e == null) {
        await _admin.createAppRelease(payload);
      } else {
        await _admin.updateAppRelease('${e['id']}', payload);
      }
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (err) {
      if (!mounted) return;
      setState(() => _busy = false);
      final msg = err is ApiException && err.code == 'version_taken'
          ? 'Ye version pehle se hai — koi aur number lagao.'
          : adminFriendly(err);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  Widget _statusChip(Map<String, dynamic> r) {
    final st = '${r['status']}';
    final color = st == 'published'
        ? Colors.green
        : st == 'archived'
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
          const Text('Filter: ', style: TextStyle(fontWeight: FontWeight.w700)),
          DropdownButton<String>(
            value: _status,
            items: const [
              DropdownMenuItem(value: '', child: Text('all')),
              DropdownMenuItem(value: 'draft', child: Text('draft')),
              DropdownMenuItem(value: 'published', child: Text('published')),
              DropdownMenuItem(value: 'archived', child: Text('archived')),
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
                          Center(child: Text('Koi release nahi.')),
                        ])
                      : ListView.builder(
                          itemCount: _items.length + 1,
                          itemBuilder: (c, i) {
                            if (i == _items.length) {
                              return Padding(
                                padding: const EdgeInsets.all(12),
                                child: Text(
                                    'Total $_total • showing ${_items.length}',
                                    style: const TextStyle(
                                        fontSize: 12, color: Colors.grey)),
                              );
                            }
                            final r = _items[i];
                            final push = (r['push'] ?? {}) as Map;
                            return Card(
                              margin: const EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 4),
                              child: Padding(
                                padding: const EdgeInsets.all(10),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(children: [
                                      Text('v${r['version']}',
                                          style: const TextStyle(
                                              fontWeight: FontWeight.w800,
                                              fontSize: 15)),
                                      const SizedBox(width: 6),
                                      if (r['mandatory'] == true)
                                        const Icon(Icons.lock, size: 14, color: Colors.red),
                                      if (r['build'] != null) ...[
                                        const SizedBox(width: 6),
                                        Text('build ${r['build']}',
                                            style: const TextStyle(
                                                fontSize: 11, color: Colors.grey)),
                                      ],
                                      const Spacer(),
                                      _statusChip(r),
                                    ]),
                                    const SizedBox(height: 2),
                                    Text(
                                        '${r['audience']} • ${r['priority']} priority${r['min_supported_version'] != null ? ' • min ${r['min_supported_version']}' : ''}',
                                        style: const TextStyle(
                                            fontSize: 11, color: Colors.grey)),
                                    Text('${r['release_notes']}',
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 13)),
                                    if (r['update_url'] != null)
                                      Text('${r['update_url']}',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                              fontSize: 11, color: Colors.blue)),
                                    Text(
                                        'Push: ${push['status'] ?? 'none'} • sent ${push['delivered'] ?? 0}/${push['total'] ?? 0} • failed ${push['failed'] ?? 0}',
                                        style: const TextStyle(
                                            fontSize: 11, color: Colors.grey)),
                                    Wrap(spacing: 4, children: [
                                      if (r['status'] != 'published')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${r['id']}',
                                                  {'status': 'published'}),
                                          child: const Text('Publish'),
                                        ),
                                      if (r['status'] == 'published')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${r['id']}',
                                                  {'status': 'archived'}),
                                          child: const Text('Archive'),
                                        ),
                                      if (push['status'] == 'failed')
                                        TextButton(
                                          onPressed: _busy
                                              ? null
                                              : () => _patch('${r['id']}',
                                                  {'retry_push': true}),
                                          child: const Text('Retry push'),
                                        ),
                                      TextButton(
                                        onPressed: () => _pushReport(r),
                                        child: const Text('Push report'),
                                      ),
                                      TextButton(
                                        onPressed:
                                            _busy ? null : () => _form(r),
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

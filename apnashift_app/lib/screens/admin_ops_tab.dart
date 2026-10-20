import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_widgets.dart';
import 'super_admin_home.dart';

/// Ops — admin-dashboard Tracking + Enterprise tabs parity +
/// password reset (accounts lookup) + logout.
/// Live maps: textual actives list (maps plugin Phase 6).
class AdminOpsTab extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminOpsTab(
      {super.key, required this.session, required this.settings});

  @override
  State<AdminOpsTab> createState() => _AdminOpsTabState();
}

class _AdminOpsTabState extends State<AdminOpsTab> {
  List<Map<String, dynamic>> _active = [];
  String _counts = '';
  List<Map<String, dynamic>> _inquiries = [];
  String _inqStatus = '';
  final _inqSearch = TextEditingController();
  final _lookupPhone = TextEditingController();
  final _newPw = TextEditingController();
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _inqSearch.dispose();
    _lookupPhone.dispose();
    _newPw.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = widget.session.admin;
      Map<String, dynamic> track = {};
      try {
        track = await api.trackingActive(limit: 50);
      } catch (_) {}
      final inq = await api.enterpriseInquiries(
          status: _inqStatus.isEmpty ? null : _inqStatus,
          search: _inqSearch.text.trim().isEmpty
              ? null
              : _inqSearch.text.trim());
      if (!mounted) return;
      final actives = (track['actives'] ??
          track['active'] ??
          track['bookings'] ??
          []) as List;
      setState(() {
        _active = actives
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        final c = track['counts'];
        _counts = c is Map ? '$c' : '';
        _inquiries = inq.items;
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

  Future<void> _setInquiry(String id, String status) async {
    try {
      await widget.session.admin.setInquiryStatus(id, status);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Status: $status')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  Future<void> _resetPw() async {
    final phone = _lookupPhone.text.trim();
    if (phone.isEmpty || _newPw.text.length < 8) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Phone + new password (8+) likho.')));
      return;
    }
    try {
      final found =
          await widget.session.admin.lookupAccount(phone);
      final users = ((found['users'] ?? []) as List)
          .whereType<Map>()
          .toList();
      final drivers = ((found['drivers'] ?? []) as List)
          .whereType<Map>()
          .toList();
      if (!mounted) return;
      if (users.isEmpty && drivers.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Account nahi mila.')));
        return;
      }
      final isUser = users.isNotEmpty;
      final id =
          '${(isUser ? users.first : drivers.first)['id']}';
      if (isUser) {
        await widget.session.admin
            .resetUserPassword(id, _newPw.text);
      } else {
        await widget.session.admin
            .resetDriverPassword(id, _newPw.text);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${isUser ? 'User' : 'Driver'} password reset.')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(adminFriendly(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.session.user;
    return AppScaffold(
      settings: widget.settings,
      title: 'Ops • ${u?.role ?? ''}',
      actions: [
        IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load),
        IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => widget.session.logout()),
      ],
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? ListView(children: [adminErrorCard(_error!)])
                : ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.person),
                          title: Text(u?.name ?? '—',
                              style: const TextStyle(
                                  fontWeight: FontWeight.w800)),
                          subtitle:
                              Text('${u?.phone ?? ''} • ${u?.role ?? ''}'),
                        ),
                      ),
                      if (u?.role == 'super_admin')
                        Card(
                          child: ListTile(
                            leading: const Icon(
                                Icons.admin_panel_settings),
                            title: const Text(
                                'Super Admin console',
                                style: TextStyle(
                                    fontWeight:
                                        FontWeight.w800)),
                            subtitle: const Text(
                                'Overview • Customers • Audit • Finance • Announcements'),
                            trailing: const Icon(
                                Icons.arrow_forward),
                            onTap: () => Navigator.of(
                                    context)
                                .push(MaterialPageRoute(
                                    builder: (_) =>
                                        SuperAdminHome(
                                            api: widget
                                                .session.api,
                                            name: u?.name ??
                                                '',
                                            settings: widget
                                                .settings))),
                          ),
                        ),
                      const SizedBox(height: 8),
                      Text(
                          'Live tracking (${_active.length}) $_counts',
                          style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      ..._active.take(15).map((a) => Card(
                            child: ListTile(
                              title: Text(
                                  '${a['booking_id'] ?? a['id'] ?? ''}',
                                  style: const TextStyle(
                                      fontWeight:
                                          FontWeight.w700)),
                              subtitle: Text(
                                  '${a['status'] ?? a['booking_status'] ?? ''} • ${a['state'] ?? ''}'),
                            ),
                          )),
                      const SizedBox(height: 8),
                      const Text('Enterprise inquiries',
                          style: TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      Row(children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _inqStatus,
                            decoration: const InputDecoration(
                                labelText: 'Status',
                                border: OutlineInputBorder()),
                            items: const [
                              DropdownMenuItem(
                                  value: '', child: Text('All')),
                              DropdownMenuItem(
                                  value: 'NEW',
                                  child: Text('NEW')),
                              DropdownMenuItem(
                                  value: 'CONTACTED',
                                  child: Text('CONTACTED')),
                              DropdownMenuItem(
                                  value: 'IN_DISCUSSION',
                                  child: Text('IN_DISCUSSION')),
                              DropdownMenuItem(
                                  value: 'CONVERTED',
                                  child: Text('CONVERTED')),
                              DropdownMenuItem(
                                  value: 'CLOSED',
                                  child: Text('CLOSED')),
                            ],
                            onChanged: (v) => setState(
                                () => _inqStatus = v ?? ''),
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                            onPressed: _load,
                            child: const Text('Load')),
                      ]),
                      const SizedBox(height: 8),
                      TextField(
                          controller: _inqSearch,
                          decoration: const InputDecoration(
                              labelText: 'Search',
                              border: OutlineInputBorder())),
                      ..._inquiries.take(15).map((q) => Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                        '${q['full_name'] ?? ''} • ${q['company_name'] ?? ''}',
                                        style: const TextStyle(
                                            fontWeight:
                                                FontWeight.w800)),
                                    Text(
                                        '${q['email'] ?? ''} • ${q['phone'] ?? ''}',
                                        style: const TextStyle(
                                            fontSize: 12)),
                                    Row(children: [
                                      adminPill(
                                          '${q['status'] ?? ''}'),
                                      const Spacer(),
                                      DropdownButton<String>(
                                        value: [
                                          'NEW',
                                          'CONTACTED',
                                          'IN_DISCUSSION',
                                          'CONVERTED',
                                          'CLOSED'
                                        ].contains('${q['status']}')
                                            ? '${q['status']}'
                                            : 'NEW',
                                        items: const [
                                          DropdownMenuItem(
                                              value: 'NEW',
                                              child: Text('NEW')),
                                          DropdownMenuItem(
                                              value: 'CONTACTED',
                                              child:
                                                  Text('CONTACTED')),
                                          DropdownMenuItem(
                                              value:
                                                  'IN_DISCUSSION',
                                              child: Text(
                                                  'IN_DISCUSSION')),
                                          DropdownMenuItem(
                                              value: 'CONVERTED',
                                              child: Text(
                                                  'CONVERTED')),
                                          DropdownMenuItem(
                                              value: 'CLOSED',
                                              child:
                                                  Text('CLOSED')),
                                        ],
                                        onChanged: (v) {
                                          if (v == null) return;
                                          _setInquiry(
                                              '${q['id']}', v);
                                        },
                                      ),
                                    ]),
                                  ]),
                            ),
                          )),
                      const SizedBox(height: 8),
                      const Text('Password reset (lookup by phone)',
                          style: TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      TextField(
                          controller: _lookupPhone,
                          keyboardType: TextInputType.phone,
                          decoration: const InputDecoration(
                              labelText: 'Phone',
                              border: OutlineInputBorder())),
                      const SizedBox(height: 8),
                      TextField(
                          controller: _newPw,
                          obscureText: true,
                          decoration: const InputDecoration(
                              labelText: 'New password (8+)',
                              border: OutlineInputBorder())),
                      const SizedBox(height: 8),
                      ElevatedButton(
                          onPressed: _resetPw,
                          child: const Text('Reset password →')),
                      const SizedBox(height: 24),
                    ],
                  ),
      ),
    );
  }
}

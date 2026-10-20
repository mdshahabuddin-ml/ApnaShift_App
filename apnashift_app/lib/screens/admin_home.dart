import 'package:flutter/material.dart';
import '../auth/admin_session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'admin_bookings_tab.dart';
import 'admin_drivers_tab.dart';
import 'admin_money_tab.dart';
import 'admin_ops_tab.dart';
import 'admin_overview_tab.dart';
import 'admin_pricing_tab.dart';

/// Admin console — admin-dashboard.html + admin-home.html parity (mobile).
/// Tabs: Overview | Drivers | Bookings | Pricing | Money | Ops.
/// Both admin + super_admin enter (super_admin passthrough backend).
class AdminHome extends StatefulWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminHome({super.key, required this.session, required this.settings});

  @override
  State<AdminHome> createState() => _AdminHomeState();
}

class _AdminHomeState extends State<AdminHome> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_onSessionChanged);
  }

  @override
  void dispose() {
    widget.session.removeListener(_onSessionChanged);
    super.dispose();
  }

  void _onSessionChanged() {
    if (!widget.session.loggedIn && mounted) {
      Navigator.of(context).popUntil((r) => r.isFirst);
    }
  }

  @override
  Widget build(BuildContext context) {
    final role = widget.session.user?.role ?? 'admin';
    return Scaffold(
      body: IndexedStack(index: _tab, children: [
        AdminOverviewTab(
            session: widget.session, settings: widget.settings),
        AdminDriversTab(
            session: widget.session, settings: widget.settings),
        AdminBookingsTab(
            session: widget.session, settings: widget.settings),
        AdminPricingTab(
            session: widget.session, settings: widget.settings),
        AdminMoneyTab(
            session: widget.session, settings: widget.settings),
        AdminOpsTab(session: widget.session, settings: widget.settings),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.dashboard), label: 'Overview'),
          NavigationDestination(
              icon: Icon(Icons.badge), label: 'Drivers'),
          NavigationDestination(
              icon: Icon(Icons.list_alt), label: 'Bookings'),
          NavigationDestination(
              icon: Icon(Icons.price_change), label: 'Pricing'),
          NavigationDestination(
              icon: Icon(Icons.account_balance_wallet),
              label: 'Money'),
          NavigationDestination(
              icon: Icon(Icons.settings), label: 'Ops'),
        ],
      ),
    );
  }
}

/// Slim account header reused by Ops tab.
class AdminAccountHeader extends StatelessWidget {
  final AdminSession session;
  final AppSettings settings;
  const AdminAccountHeader(
      {super.key, required this.session, required this.settings});

  @override
  Widget build(BuildContext context) {
    final u = session.user;
    return AppScaffold(
      settings: settings,
      title: 'Admin • ${u?.name ?? ''} (${u?.role ?? ''})',
      actions: [
        IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => session.logout()),
      ],
      body: const Center(child: Text('Work from the Ops tabs.')),
    );
  }
}

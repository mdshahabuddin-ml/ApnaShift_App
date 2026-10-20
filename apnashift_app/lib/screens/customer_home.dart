import 'package:flutter/material.dart';
import '../auth/session.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'bookings_screen.dart';
import 'create_booking_screen.dart';
import 'enterprise_screen.dart';
import 'help_screen.dart';
import 'legal_screen.dart';
import 'notifications_screen.dart';

/// Logged-in customer shell — bottom tabs: Book | My Bookings | Alerts | Account.
/// Preserves BookingsScreen (list) + Session gate from main.dart.
class CustomerHome extends StatefulWidget {
  final Session session;
  final AppSettings settings;
  const CustomerHome(
      {super.key, required this.session, required this.settings});

  @override
  State<CustomerHome> createState() => _CustomerHomeState();
}

class _CustomerHomeState extends State<CustomerHome> {
  int _tab = 1;

  @override
  Widget build(BuildContext context) {
    final pages = [
      CreateBookingScreen(
          session: widget.session, settings: widget.settings),
      BookingsScreen(
          session: widget.session,
          settings: widget.settings,
          active: _tab == 1),
      NotificationsScreen(
          session: widget.session, settings: widget.settings),
      _AccountTab(session: widget.session, settings: widget.settings),
    ];
    return Scaffold(
      body: IndexedStack(index: _tab, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
              icon: Icon(Icons.add_box), label: 'Book'),
          NavigationDestination(
              icon: Icon(Icons.list_alt), label: 'My Bookings'),
          NavigationDestination(
              icon: Icon(Icons.notifications), label: 'Alerts'),
          NavigationDestination(
              icon: Icon(Icons.person), label: 'Account'),
        ],
      ),
    );
  }
}

class _AccountTab extends StatelessWidget {
  final Session session;
  final AppSettings settings;
  const _AccountTab({required this.session, required this.settings});

  @override
  Widget build(BuildContext context) {
    final u = session.user;
    return AppScaffold(
      settings: settings,
      title: 'Account',
      actions: [
        IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => session.logout()),
      ],
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const Icon(Icons.person, size: 40),
              title: Text(u?.name ?? '—',
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              subtitle: Text('${u?.phone ?? '—'}\nRole: ${u?.role ?? '—'}'),
              isThreeLine: true,
            ),
          ),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Preferences (website parity)',
                        style: TextStyle(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 8),
                    Row(children: [
                      const Text('Language: '),
                      TextButton(
                          onPressed: () => settings.setLang('en'),
                          child: Text(
                              'English ${settings.lang == 'en' ? '✓' : ''}')),
                      TextButton(
                          onPressed: () => settings.setLang('hi'),
                          child: Text(
                              'हिन्दी ${settings.lang == 'hi' ? '✓' : ''}')),
                    ]),
                    Row(children: [
                      const Text('Theme: '),
                      TextButton(
                          onPressed: () => settings.setTheme('light'),
                          child: const Text('☀')),
                      TextButton(
                          onPressed: () => settings.setTheme('dark'),
                          child: const Text('☾')),
                      TextButton(
                          onPressed: () => settings.setTheme('system'),
                          child: const Text('◐')),
                    ]),
                    Row(children: [
                      const Text('Text: '),
                      TextButton(
                          onPressed: () => settings.bumpText(-2),
                          child: const Text('A-')),
                      TextButton(
                          onPressed: () => settings.resetText(),
                          child: const Text('A')),
                      TextButton(
                          onPressed: () => settings.bumpText(2),
                          child: const Text('A+')),
                    ]),
                  ]),
            ),
          ),
          const SizedBox(height: 8),
          ElevatedButton(
              onPressed: () => session.logout(),
              child: const Text('Logout →')),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => EnterpriseScreen(
                            settings: settings))),
                child: const Text('Enterprise →')),
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) =>
                            HelpScreen(settings: settings))),
                child: const Text('Help →')),
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => LegalScreen(
                            settings: settings,
                            page: LegalPage.privacy))),
                child: const Text('Privacy')),
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => LegalScreen(
                            settings: settings,
                            page: LegalPage.terms))),
                child: const Text('Terms')),
          ]),
          const SizedBox(height: 4),
          const Text('support@apnashift.in',
              style: TextStyle(color: Colors.grey, fontSize: 12)),
        ],
      ),
    );
  }
}

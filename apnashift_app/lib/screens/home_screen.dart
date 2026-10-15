import 'package:flutter/material.dart';
import '../auth/session.dart';
import '../l10n/strings.dart';
import '../settings/app_settings.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';

// Public landing parity — apnashift-frontend/index.html:
// hero (Move smarter + vehicle chooser), audience cards,
// how-it-works, vehicles, why+safety, FAQ, footer.
// Logged-out users land here; logged-in customers go to bookings (main.dart).
class HomeScreen extends StatelessWidget {
  final Session session;
  final AppSettings settings;
  final VoidCallback onBook;
  final VoidCallback onLogin;
  final VoidCallback onDriverJoin;
  final VoidCallback onDriverLogin;
  final VoidCallback onEnterprise;
  final VoidCallback onHelp;
  final VoidCallback? onAdmin;

  const HomeScreen({
    super.key,
    required this.session,
    required this.settings,
    required this.onBook,
    required this.onLogin,
    required this.onDriverJoin,
    required this.onDriverLogin,
    required this.onEnterprise,
    required this.onHelp,
    this.onAdmin,
  });

  @override
  Widget build(BuildContext context) {
    final lang = settings.lang;
    final delta = settings.textDelta;
    return AppScaffold(
      settings: settings,
      title: 'ApnaShift',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Hero panel (navy gradient parity)
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [appNavy, Color(0xFF132540), Color(0xFF241D12)],
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.white24,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(t(lang, 'hero_badge'),
                      style: TextStyle(
                          color: Colors.white, fontSize: 11 + delta * 0.5)),
                ),
                const SizedBox(height: 12),
                Text(t(lang, 'hero_title'),
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 28 + delta,
                        fontWeight: FontWeight.w800)),
                const SizedBox(height: 8),
                Text(t(lang, 'hero_sub'),
                    style: TextStyle(
                        color: Colors.white70, fontSize: 14 + delta * 0.5)),
                const SizedBox(height: 16),
                Wrap(spacing: 10, runSpacing: 10, children: [
                  ElevatedButton(
                      onPressed: onBook, child: Text(t(lang, 'book_now'))),
                  OutlinedButton(
                      onPressed: onLogin,
                      style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.white,
                          side: const BorderSide(color: Colors.white38)),
                      child: Text(t(lang, 'nav_login'))),
                ]),
              ],
            ),
          ),
          const SizedBox(height: 16),
          // Vehicle chooser → booking.html parity (4 cards)
          Text(t(lang, 'vehicles_title'),
              style: TextStyle(
                  fontSize: 18 + delta, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            childAspectRatio: 1.6,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            children: const [
              _VehicleCard(icon: Icons.local_shipping, label: 'Mini Truck'),
              _VehicleCard(icon: Icons.fire_truck, label: 'Pickup'),
              _VehicleCard(icon: Icons.agriculture, label: 'Mini Tractor'),
              _VehicleCard(icon: Icons.two_wheeler, label: 'Motorbike'),
            ],
          ),
          const SizedBox(height: 16),
          // Audience cards
          _AudienceCard(
            title: t(lang, 'nav_login'),
            sub: 'Customer • Book • Track',
            onTap: onLogin,
          ),
          _AudienceCard(
            title: t(lang, 'nav_join'),
            sub: 'Driver • Earn • Trips',
            onTap: onDriverJoin,
          ),
          _AudienceCard(
            title: t(lang, 'nav_enterprise'),
            sub: 'B2B • Fleet • Monthly trips',
            onTap: onEnterprise,
          ),
          const SizedBox(height: 16),
          Text(t(lang, 'how_title'),
              style: TextStyle(
                  fontSize: 18 + delta, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          const _StepsList(),
          const SizedBox(height: 16),
          Text(t(lang, 'faq_title'),
              style: TextStyle(
                  fontSize: 18 + delta, fontWeight: FontWeight.w800)),
          const _FaqList(),
          const SizedBox(height: 16),
          Wrap(spacing: 10, children: [
            TextButton(onPressed: onDriverLogin,
                child: Text(t(lang, 'nav_driver_login'))),
            TextButton(onPressed: onHelp, child: Text(t(lang, 'nav_help'))),
            if (onAdmin != null)
              TextButton(
                  onPressed: onAdmin,
                  child: const Text('Admin →',
                      style: TextStyle(color: Colors.grey))),
          ]),
          const SizedBox(height: 8),
          Text(t(lang, 'footer_support'),
              style: const TextStyle(color: Colors.grey, fontSize: 12)),
          Text(t(lang, 'phase2_note'),
              style: const TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _VehicleCard extends StatelessWidget {
  final IconData icon;
  final String label;
  const _VehicleCard({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, color: appNavy, size: 32),
          const SizedBox(height: 6),
          Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
        ]),
      ),
    );
  }
}

class _AudienceCard extends StatelessWidget {
  final String title;
  final String sub;
  final VoidCallback onTap;
  const _AudienceCard(
      {required this.title, required this.sub, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(sub),
        trailing: const Icon(Icons.arrow_forward),
        onTap: onTap,
      ),
    );
  }
}

class _StepsList extends StatelessWidget {
  const _StepsList();

  @override
  Widget build(BuildContext context) {
    const steps = [
      '1. Pickup + drop likho',
      '2. Vehicle chuno + estimate dekho',
      '3. Confirm karo — driver assign',
      '4. Live track + delivery',
    ];
    return Column(
      children: steps
          .map((s) => Card(
                margin: const EdgeInsets.symmetric(vertical: 4),
                child: ListTile(leading: const Icon(Icons.check_circle, color: appNavy), title: Text(s)),
              ))
          .toList(),
    );
  }
}

class _FaqList extends StatelessWidget {
  const _FaqList();

  @override
  Widget build(BuildContext context) {
    return const Column(children: [
      ExpansionTile(title: Text('Price kaise banta hai?'), children: [
        Padding(
            padding: EdgeInsets.all(12),
            child: Text(
                'Base + per-km × distance + helper — website jaisa estimate Phase 2 me.'))
      ]),
      ExpansionTile(title: Text('Payment kaise?'), children: [
        Padding(
            padding: EdgeInsets.all(12),
            child: Text('UPI / Cash — website parity Phase 2 me.'))
      ]),
    ]);
  }
}

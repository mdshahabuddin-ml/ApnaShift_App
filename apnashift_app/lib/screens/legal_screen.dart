import 'package:flutter/material.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';

/// Privacy Policy + Terms & Conditions — privacy.html / terms.html parity.
/// Full text bundled (website source of truth, 1 October 2026).
enum LegalPage { privacy, terms }

class LegalScreen extends StatelessWidget {
  final AppSettings settings;
  final LegalPage page;
  const LegalScreen(
      {super.key, required this.settings, required this.page});

  @override
  Widget build(BuildContext context) {
    final isPrivacy = page == LegalPage.privacy;
    return AppScaffold(
      settings: settings,
      title: isPrivacy ? 'Privacy Policy' : 'Terms & Conditions',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
              isPrivacy
                  ? 'Privacy Policy'
                  : 'Terms & Conditions',
              style: const TextStyle(
                  fontWeight: FontWeight.w800, fontSize: 20)),
          const Text('Last updated: 1 October 2026',
              style: TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 12),
          if (isPrivacy) ..._privacy() else ..._terms(),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  List<Widget> _privacy() => const [
        Text(
            'ApnaShift ("we", "our") respects your privacy. This policy explains what data we collect, why we collect it, and what your rights are — in accordance with India\'s Digital Personal Data Protection Act (DPDP Act).'),
        SizedBox(height: 12),
        Text('1. What data we collect',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• Name — to identify your account and bookings.\n• Phone number — for login, booking updates, and support communication.\n• Pickup and drop addresses — to complete your shifting booking.\n• Booking history — a record of your past and ongoing bookings.\n• Vehicle details (for drivers) — registration details such as vehicle type, vehicle number, license, and service area.'),
        SizedBox(height: 12),
        Text('2. Why we collect it',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• To process bookings — your details are required for pickup, pricing, and scheduling.\n• To assign a driver — address and requirement data is used to match you with a driver with the right vehicle and service area.\n• For support — to contact you and provide assistance if any issue arises.\nWe do not use your data for any purpose other than those described here.'),
        SizedBox(height: 12),
        Text('3. Who we share it with',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• Only the information required for your booking — for example, the assigned driver receives the pickup/drop address and phone number, and the customer receives the driver\'s name and vehicle number.\n• We do not sell your data to third parties — your personal data is never shared for advertising or marketing purposes.'),
        SizedBox(height: 12),
        Text('4. How long we store your data',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'Your data is retained only for as long as necessary for bookings, support, and legal record-keeping. When you delete your account, your personal data is removed from our active systems (except for records we are legally required to retain).'),
        SizedBox(height: 12),
        Text('5. Your rights',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'You have the right to view, update, and request deletion of your data. Contact: support@apnashift.in — send "data request" from your registered phone number so we can verify identity.'),
        SizedBox(height: 12),
        Text('6. Security',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• Passwords are stored in hashed form — we can never view your actual password.\n• Data is transmitted over HTTPS.\n• Internal access is limited to authorized staff only.'),
        SizedBox(height: 12),
        Text('7. Questions',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'If you have any questions about privacy, write to support@apnashift.in — we will respond.'),
      ];

  List<Widget> _terms() => const [
        Text(
            'Disclaimer: ApnaShift is currently in a testing/beta phase. These terms are kept simple and may change over time.',
            style: TextStyle(fontWeight: FontWeight.w600)),
        SizedBox(height: 12),
        Text('1. What the service is',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'ApnaShift is a platform that connects customers with independent drivers for shifting and transportation (pickup, mini truck, mini tractor). We do not operate vehicles ourselves — we provide booking, price estimates, and driver-matching services.'),
        SizedBox(height: 12),
        Text('2. Booking and cancellation',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• You can cancel free of charge at any time before your booking is confirmed.\n• If you cancel after confirmation, no charge currently applies during the testing phase.\n• After the driver has arrived, speak directly with the driver — be mindful of their time.'),
        SizedBox(height: 12),
        Text('3. Payment',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• Please pay the driver directly — by cash or UPI.\n• ApnaShift currently offers no in-app payments; the app will not charge you.\n• The shown price is only an estimate; confirm the final fare with the driver before the trip.'),
        SizedBox(height: 12),
        Text('4. Responsibilities — driver vs ApnaShift',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            '• Driver: loading, transporting, unloading carefully, arriving on time.\n• ApnaShift: bookings, price estimates, support.\n• ApnaShift currently provides no insurance for damage/loss of goods. Speak with the driver first, then support — we facilitate resolution but do not guarantee compensation.'),
        SizedBox(height: 12),
        Text('5. Account suspension and bans',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'Wrong phone numbers, fake bookings, misbehaviour with a driver, or system misuse may lead to suspension or ban — including without prior notice in serious cases.'),
        SizedBox(height: 12),
        Text('6. Dispute resolution',
            style:
                TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        Text(
            'Contact support@apnashift.in first. We hear both sides and attempt resolution. Unresolved matters follow the laws applicable in Indore (Madhya Pradesh).'),
      ];
}

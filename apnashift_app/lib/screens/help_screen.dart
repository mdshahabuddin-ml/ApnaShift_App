import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../settings/app_settings.dart';
import '../widgets/app_scaffold.dart';
import 'legal_screen.dart';

/// Help/support — help.html parity (mobile). No backend API (website bhi
/// wa.me + mailto use karta hai): WhatsApp handoff + Email + FAQ + form
/// jo WhatsApp message banata hai. Validations website jaisi.
class HelpScreen extends StatefulWidget {
  final AppSettings settings;
  const HelpScreen({super.key, required this.settings});

  @override
  State<HelpScreen> createState() => _HelpScreenState();
}

const _wa = '918757160137';
const _supportMail = 'support@apnashift.in';

class _HelpScreenState extends State<HelpScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  String _issue = 'Booking';
  final _desc = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _desc.dispose();
    super.dispose();
  }

  Future<void> _waOpen(String text) async {
    final uri =
        Uri.parse('https://wa.me/$_wa?text=${Uri.encodeComponent(text)}');
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('WhatsApp did not open — message 918757160137.')));
    }
  }

  Future<void> _mailOpen() async {
    final uri = Uri.parse(
        'mailto:$_supportMail?subject=${Uri.encodeComponent('ApnaShift Support Request')}');
    try {
      await launchUrl(uri);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Email app did not open — email support@apnashift.in.')));
    }
  }

  void _sendForm() {
    if (_name.text.trim().length < 2) {
      setState(() => _error = 'Name must be at least 2 characters.');
      return;
    }
    var p = _phone.text.replaceAll(RegExp(r'[\s\-]'), '');
    if (p.startsWith('+91')) p = p.substring(3);
    if (p.startsWith('91') && p.length == 12) p = p.substring(2);
    if (!RegExp(r'^[6-9][0-9]{9}$').hasMatch(p)) {
      setState(() =>
          _error = 'Phone must be a 10-digit Indian mobile number (starting with 6-9).');
      return;
    }
    if (_desc.text.trim().length < 5) {
      setState(() => _error = 'Detail must be at least 5 characters.');
      return;
    }
    setState(() => _error = null);
    _waOpen(
        'ApnaShift Help\nName: ${_name.text.trim()}\nPhone: $p\nIssue: $_issue\n${_desc.text.trim()}');
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      settings: widget.settings,
      title: 'Help',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Help & Support',
              style:
                  TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Contact',
                        style: TextStyle(
                            fontWeight: FontWeight.w800)),
                    const SizedBox(height: 8),
                    ElevatedButton(
                        onPressed: () => _waOpen(
                            'ApnaShift Help — I need help.'),
                        child: const Text(
                            'WhatsApp: 918757160137 →')),
                    const SizedBox(height: 8),
                    OutlinedButton(
                        onPressed: _mailOpen,
                        child: const Text(
                            '✉️ support@apnashift.in')),
                  ]),
            ),
          ),
          const SizedBox(height: 8),
          const Text('FAQ',
              style:
                  TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          const ExpansionTile(
              title: Text('How is the price calculated?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Base + per-km × distance + helper — the estimate always comes from the server.'))
              ]),
          const ExpansionTile(
              title: Text('How do I pay?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Directly to the driver — Cash or UPI. The app does not charge you.'))
              ]),
          const ExpansionTile(
              title: Text('How do I cancel?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Free cancellation while pending/accepted — with a reason. After Arrived, talk to the driver.'))
              ]),
          const ExpansionTile(
              title: Text('How do I become a driver?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Join as Driver — after the application, the admin verifies it.'))
              ]),
          const ExpansionTile(
              title: Text('What if my goods are damaged?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'First the driver, then support@apnashift.in — there is no insurance (see the terms).'))
              ]),
          const SizedBox(height: 8),
          const Text('Send an issue',
              style:
                  TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          if (_error != null)
            Container(
                margin: const EdgeInsets.symmetric(vertical: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                    color: Colors.red.shade50,
                    borderRadius: BorderRadius.circular(10)),
                child: Text(_error!,
                    style: const TextStyle(color: Colors.red))),
          TextField(
              controller: _name,
              decoration: const InputDecoration(
                  labelText: 'Name *',
                  border: OutlineInputBorder())),
          const SizedBox(height: 8),
          TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                  labelText: 'Phone *',
                  border: OutlineInputBorder())),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _issue,
            decoration: const InputDecoration(
                labelText: 'Issue type *',
                border: OutlineInputBorder()),
            items: const [
              DropdownMenuItem(
                  value: 'Booking', child: Text('Booking')),
              DropdownMenuItem(
                  value: 'Driver', child: Text('Driver')),
              DropdownMenuItem(
                  value: 'Payment', child: Text('Payment')),
              DropdownMenuItem(
                  value: 'Else', child: Text('Else')),
            ],
            onChanged: (v) =>
                setState(() => _issue = v ?? 'Booking'),
          ),
          const SizedBox(height: 8),
          TextField(
              controller: _desc,
              maxLength: 500,
              maxLines: 3,
              decoration: const InputDecoration(
                  labelText: 'Detail * (min 5)',
                  border: OutlineInputBorder())),
          const SizedBox(height: 8),
          ElevatedButton(
              onPressed: _sendForm,
              child: const Text('Send via WhatsApp →')),
          const SizedBox(height: 8),
          Row(children: [
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => LegalScreen(
                            settings: widget.settings,
                            page: LegalPage.privacy))),
                child: const Text('Privacy Policy')),
            TextButton(
                onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => LegalScreen(
                            settings: widget.settings,
                            page: LegalPage.terms))),
                child: const Text('Terms')),
          ]),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

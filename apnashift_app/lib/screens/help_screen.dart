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
          content: Text('WhatsApp nahi khula — 918757160137 par likho.')));
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
          content: Text('Email app nahi khuli — support@apnashift.in par likho.')));
    }
  }

  void _sendForm() {
    if (_name.text.trim().length < 2) {
      setState(() => _error = 'Naam kam se kam 2 akshar.');
      return;
    }
    var p = _phone.text.replaceAll(RegExp(r'[\s\-]'), '');
    if (p.startsWith('+91')) p = p.substring(3);
    if (p.startsWith('91') && p.length == 12) p = p.substring(2);
    if (!RegExp(r'^[6-9][0-9]{9}$').hasMatch(p)) {
      setState(() => _error = 'Phone 10 digit Indian mobile (6-9 se shuru).');
      return;
    }
    if (_desc.text.trim().length < 5) {
      setState(() => _error = 'Detail kam se kam 5 akshar.');
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
                            'ApnaShift Help — mujhe madad chahiye.'),
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
              title: Text('Price kaise banta hai?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Base + per-km × distance + helper — estimate hamesha server se aata hai.'))
              ]),
          const ExpansionTile(
              title: Text('Payment kaise?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Driver ko direct — Cash ya UPI. App tumhe charge nahi karta.'))
              ]),
          const ExpansionTile(
              title: Text('Cancel kaise?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'pending/accepted par free cancel — reason ke saath. Arrived ke baad driver se baat karo.'))
              ]),
          const ExpansionTile(
              title: Text('Driver kaise bane?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Join as Driver — application ke baad admin verify karta hai.'))
              ]),
          const ExpansionTile(
              title: Text('Samaan damage ho to?'),
              children: [
                Padding(
                    padding: EdgeInsets.all(12),
                    child: Text(
                        'Pehle driver, phir support@apnashift.in — insurance nahi hai (terms dekho).'))
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

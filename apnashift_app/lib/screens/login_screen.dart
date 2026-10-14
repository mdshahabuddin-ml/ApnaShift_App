import 'package:flutter/material.dart';
import '../auth/session.dart';

const navy = Color(0xFF0A2340);
const yellow = Color(0xFFFFB200);

/// Customer login. Admin number yahan kabhi kaam nahi karega
/// (backend alag tables rakhta hai — by design).
class LoginScreen extends StatefulWidget {
  final Session session;
  const LoginScreen({super.key, required this.session});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

String _friendly(String code) {
  switch (code) {
    case 'invalid_credentials':
      return 'Galat number ya password.';
    case 'validation_failed':
      return '10-digit mobile (6-9 se shuru) + sahi password likho.';
    case 'too_many_attempts':
      return 'Bahut tries — 15 minute ruk ke retry karo.';
    default:
      return 'Login fail ($code). Server http://10.0.2.2:3000 chal raha hai?';
  }
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _pass = TextEditingController();
  String? _error;
  bool _busy = false;

  Future<void> _go() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.session.login(phone: _phone.text.trim(), password: _pass.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err == null ? null : _friendly(err);
    });
  }

  @override
  void dispose() {
    _phone.dispose();
    _pass.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: navy,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('ApnaShift', style: TextStyle(color: Colors.white, fontSize: 32, fontWeight: FontWeight.w800)),
                const Text('SHIFTING • TRANSPORT', style: TextStyle(color: yellow, letterSpacing: 3, fontSize: 12)),
                const SizedBox(height: 32),
                if (_error != null)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(10)),
                    child: Text(_error!, style: const TextStyle(color: Colors.red)),
                  ),
                if (_error != null) const SizedBox(height: 12),
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    labelText: 'Mobile number',
                    labelStyle: TextStyle(color: Colors.white70),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _pass,
                  obscureText: true,
                  style: const TextStyle(color: Colors.white),
                  decoration: const InputDecoration(
                    labelText: 'Password',
                    labelStyle: TextStyle(color: Colors.white70),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white38)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: yellow)),
                  ),
                  onSubmitted: (_) => _go(),
                ),
                const SizedBox(height: 20),
                ElevatedButton(
                  onPressed: _busy ? null : _go,
                  style: ElevatedButton.styleFrom(backgroundColor: yellow, foregroundColor: navy, padding: const EdgeInsets.all(16)),
                  child: Text(_busy ? 'Ruko…' : 'Login →', style: const TextStyle(fontWeight: FontWeight.w800)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

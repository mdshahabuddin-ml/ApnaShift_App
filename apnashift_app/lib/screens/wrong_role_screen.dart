import 'package:flutter/material.dart';
import '../auth/session.dart';
import 'login_screen.dart';

/// Logged in, par role customer nahi (admin/driver number).
/// Backend sahi me 403 deta hai — yahan friendly samjhate hain.
class WrongRoleScreen extends StatelessWidget {
  final Session session;
  const WrongRoleScreen({super.key, required this.session});

  @override
  Widget build(BuildContext context) {
    final role = session.user?.role ?? '?';
    final name = session.user?.name ?? '';
    return Scaffold(
      appBar: AppBar(title: const Text('ApnaShift'), backgroundColor: navy, foregroundColor: Colors.white),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Namaste, $name', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            Text(
              'Ye number ($role account) customer app me nahi chalega.\n\n'
              '• Customer login chahiye to customer account se login karo.\n'
              '• Admin kaam ke liye browser me /super-admin.html kholo.',
              style: const TextStyle(fontSize: 15, height: 1.5),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: () => session.logout(),
              style: ElevatedButton.styleFrom(backgroundColor: yellow, foregroundColor: navy, padding: const EdgeInsets.all(16)),
              child: const Text('Logout (dusre number se login)', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
          ],
        ),
      ),
    );
  }
}

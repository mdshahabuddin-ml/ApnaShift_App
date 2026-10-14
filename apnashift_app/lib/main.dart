import 'package:flutter/material.dart';
import 'auth/session.dart';
import 'screens/bookings_screen.dart';
import 'screens/login_screen.dart' show navy, yellow, LoginScreen;

void main() {
  runApp(const ApnaShiftApp());
}

class ApnaShiftApp extends StatefulWidget {
  final Session? session;
  const ApnaShiftApp({super.key, this.session});

  @override
  State<ApnaShiftApp> createState() => _ApnaShiftAppState();
}

class _ApnaShiftAppState extends State<ApnaShiftApp> {
  late final Session _session = widget.session ?? Session();

  @override
  void initState() {
    super.initState();
    _session.addListener(_tick);
    _session.restore();
  }

  void _tick() => setState(() {});

  @override
  void dispose() {
    _session.removeListener(_tick);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ApnaShift',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: navy).copyWith(secondary: yellow),
        useMaterial3: true,
      ),
      home: !_session.ready
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _session.loggedIn
              ? BookingsScreen(session: _session)
              : LoginScreen(session: _session),
    );
  }
}

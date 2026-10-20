// Admin Login (Super Admin entry) password field: eye/eye-off toggle.
// Hidden by default; suffix icon flips obscureText both ways.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:apnashift_app/auth/admin_session.dart';
import 'package:apnashift_app/auth/token_store.dart';
import 'package:apnashift_app/screens/admin_login_screen.dart';
import 'package:apnashift_app/settings/app_settings.dart';

void main() {
  testWidgets('password hidden by default, eye toggles visibility',
      (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      home: AdminLoginScreen(
        session: AdminSession(store: MemoryTokenStore()),
        settings: AppSettings.test(),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));

    final pwField = find.byType(TextField).at(1);
    await tester.enterText(pwField, 'secret123');

    EditableText editable() => tester.widget<EditableText>(
        find.descendant(of: pwField, matching: find.byType(EditableText)));

    // Hidden by default: eye-off icon shown, text obscured.
    expect(editable().obscureText, isTrue);
    expect(find.byIcon(Icons.visibility_off), findsOneWidget);

    // Tap eye -> visible.
    await tester.tap(find.byIcon(Icons.visibility_off));
    await tester.pump();
    expect(editable().obscureText, isFalse);
    expect(find.byIcon(Icons.visibility), findsOneWidget);

    // Tap eye-off -> hidden again.
    await tester.tap(find.byIcon(Icons.visibility));
    await tester.pump();
    expect(editable().obscureText, isTrue);
    expect(find.byIcon(Icons.visibility_off), findsOneWidget);
  });
}

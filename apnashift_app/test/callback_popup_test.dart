// Callback popup tests — reference design (fields + orange first-field
// border + button), required/Indian-mobile validation, first-visit policy
// (once-ever) aur widget-test env skip. Koi network/plugin nahi: store
// map-backed fake (CallbackPopupStorage) se inject hota hai.
// Run: flutter test test/callback_popup_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:apnashift_app/widgets/callback_popup.dart';

class _MemStorage implements CallbackPopupStorage {
  final Map<String, String> data = {};

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async {
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    data.remove(key);
  }
}

void main() {
  group('CallbackPopupStore (first-visit policy)', () {
    test('new visitor (no state) shows the popup', () async {
      final store = CallbackPopupStore(storage: _MemStorage());
      expect(await store.shouldShow(), isTrue);
      expect(await store.status(), isNull);
    });

    test('shown/dismissed once = kabhi dobara nahi (reshowAfterDays=0)',
        () async {
      final mem = _MemStorage();
      final store = CallbackPopupStore(storage: mem);
      await store.write('shown');
      expect(await store.status(), 'shown');
      expect(await store.shouldShow(), isFalse);
      await store.write('dismissed');
      expect(await store.status(), 'dismissed');
      expect(await store.shouldShow(), isFalse);
    });

    test('submitted lead = kabhi dobara nahi', () async {
      final store = CallbackPopupStore(storage: _MemStorage());
      await store.write('submitted');
      expect(await store.shouldShow(), isFalse);
    });

    test('reset (dev/tests) = dobara genuinely new visitor', () async {
      final store = CallbackPopupStore(storage: _MemStorage());
      await store.write('dismissed');
      await store.reset();
      expect(await store.shouldShow(), isTrue);
    });

    test('storage error = fail-soft (no crash, policy safe)', () async {
      final store = CallbackPopupStore(storage: _ThrowingStorage());
      expect(await store.shouldShow(), isTrue); // no state = new visitor
      await store.write('shown'); // throws inside, swallowed
      expect(await store.status(), isNull);
    });
  });

  group('CallbackPopup widget (reference design + validation)', () {
    late CallbackPopupStore store;

    setUp(() {
      store = CallbackPopupStore(storage: _MemStorage());
    });

    Future<void> openPopup(WidgetTester tester) async {
      tester.view.physicalSize = const Size(760, 1300);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => CallbackPopup(store: store),
            ),
            child: const Text('open'),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('design: heading, copy, 4 fields, orange button, close ×',
        (WidgetTester tester) async {
      await openPopup(tester);

      expect(find.text('Moving Soon?'), findsOneWidget);
      expect(
          find.textContaining(
              'Get a free, no-obligation callback from our ApnaShift App'),
          findsOneWidget);
      expect(find.widgetWithText(TextField, 'From City'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'To City'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Your Name'), findsOneWidget);
      expect(find.widgetWithText(TextField, 'Phone Number*'), findsOneWidget);
      expect(find.widgetWithText(ElevatedButton, 'Get a Callback'),
          findsOneWidget);
      expect(find.byIcon(Icons.close), findsOneWidget);

      // Pehle field ka orange focus border + baaki fields ki light border.
      final fields = tester.widgetList<TextField>(find.byType(TextField));
      final first = fields.first.decoration!.enabledBorder as OutlineInputBorder;
      final second = fields.elementAt(1).decoration!.enabledBorder
          as OutlineInputBorder;
      expect(first.borderSide.color, const Color(0xFFFF6B00));
      expect(second.borderSide.color, const Color(0xFFDBE4F0));
    });

    testWidgets('empty submit = required errors on all 4 fields',
        (WidgetTester tester) async {
      await openPopup(tester);
      await tester.tap(find.widgetWithText(ElevatedButton, 'Get a Callback'));
      await tester.pump();

      expect(find.text('From city is required.'), findsOneWidget);
      expect(find.text('To city is required.'), findsOneWidget);
      expect(find.text('Please enter your name.'), findsOneWidget);
      expect(find.text('Phone number is required.'), findsOneWidget);
      expect(find.text('Thank you!'), findsNothing);
    });

    testWidgets('Indian mobile validation: 5555555555 reject, 6-9 se shuru '
        '10 digit accept', (WidgetTester tester) async {
      await openPopup(tester);
      await tester.enterText(find.byType(TextField).at(0), 'Pune');
      await tester.enterText(find.byType(TextField).at(1), 'Mumbai');
      await tester.enterText(find.byType(TextField).at(2), 'Rahul');
      await tester.enterText(find.byType(TextField).at(3), '5555555555');
      await tester.tap(find.widgetWithText(ElevatedButton, 'Get a Callback'));
      await tester.pump();
      expect(
          find.text(
              'Enter a valid 10-digit Indian mobile number (starts with 6-9).'),
          findsOneWidget);
      expect(find.text('Thank you!'), findsNothing);

      // Valid + prefix normalize (+91/0 chalta hai — website parity).
      await tester.enterText(find.byType(TextField).at(3), '+91 98765 43210');
      await tester.tap(find.widgetWithText(ElevatedButton, 'Get a Callback'));
      await tester.pump();

      expect(find.text('Thank you!'), findsOneWidget);
      expect(await store.status(), 'submitted');
      expect(await store.shouldShow(), isFalse);

      // launchUrl fail hone par SnackBar (4s timer) — settle karke khatam.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    });

    testWidgets('close (×) dismisses the dialog without blocking',
        (WidgetTester tester) async {
      await openPopup(tester);
      expect(find.text('Moving Soon?'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.close));
      await tester.pumpAndSettle();
      expect(find.text('Moving Soon?'), findsNothing);

      // Dismiss state persist = dobara nahi (once-ever policy).
      await store.write('dismissed');
      expect(await store.shouldShow(), isFalse);
    });
  });

  group('CallbackPopupGate', () {
    testWidgets('widget-test env me auto-popup kabhi nahi khulta',
        (WidgetTester tester) async {
      CallbackPopupGate.instance.reset();
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await CallbackPopupGate.instance.maybeShow(
        tester.element(find.byType(SizedBox)),
        guest: true,
      );
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
      expect(CallbackPopupGate.instance.checked, isTrue);
      CallbackPopupGate.instance.reset();
    });
  });
}

class _ThrowingStorage implements CallbackPopupStorage {
  @override
  Future<String?> read(String key) async => throw StateError('keystore fail');

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('keystore fail');

  @override
  Future<void> delete(String key) async => throw StateError('keystore fail');
}

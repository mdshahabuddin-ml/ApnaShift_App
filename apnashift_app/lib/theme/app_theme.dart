import 'package:flutter/material.dart';

// Website parity branding (index.html / theme.js):
// navy #0A2340 header/footer, yellow #FFB200 primary CTA.
// Dark mode values mirror theme.js: bg #0b1526, card #111f36.
const Color appNavy = Color(0xFF0A2340);
const Color appYellow = Color(0xFFFFB200);
const Color appDarkBg = Color(0xFF0B1526);
const Color appDarkCard = Color(0xFF111F36);

ThemeData buildLightTheme(double textDeltaPx) {
  final base = ThemeData(
    colorScheme: ColorScheme.fromSeed(seedColor: appNavy).copyWith(
      secondary: appYellow,
      primary: appNavy,
    ),
    useMaterial3: true,
  );
  return base.copyWith(
    scaffoldBackgroundColor: Colors.white,
    appBarTheme: const AppBarTheme(
      backgroundColor: appNavy,
      foregroundColor: Colors.white,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: appYellow,
        foregroundColor: appNavy,
        textStyle: TextStyle(
          fontWeight: FontWeight.w800,
          fontSize: 16 + textDeltaPx,
        ),
      ),
    ),
  );
}

ThemeData buildDarkTheme(double textDeltaPx) {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    colorScheme: ColorScheme.fromSeed(
      seedColor: appNavy,
      brightness: Brightness.dark,
    ).copyWith(secondary: appYellow, primary: const Color(0xFF8AB4F8)),
    scaffoldBackgroundColor: appDarkBg,
    cardColor: appDarkCard,
    appBarTheme: const AppBarTheme(
      backgroundColor: appNavy,
      foregroundColor: Colors.white,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: appYellow,
        foregroundColor: appNavy,
        textStyle: TextStyle(
          fontWeight: FontWeight.w800,
          fontSize: 16 + textDeltaPx,
        ),
      ),
    ),
  );
}

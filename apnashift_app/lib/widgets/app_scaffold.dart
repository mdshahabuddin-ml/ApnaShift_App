import 'package:flutter/material.dart';
import '../l10n/strings.dart';
import '../settings/app_settings.dart';
import '../theme/app_theme.dart';

// Website parity header/footer: navy header (ApnaShift + nav + actions),
// theme dropdown (☀/☾/◐), language dropdown (🌐 EN/HI), text-size A-/A/A+.
class AppScaffold extends StatelessWidget {
  final AppSettings settings;
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? drawer;
  final Widget? bottomNav;
  final FloatingActionButton? fab;

  const AppScaffold({
    super.key,
    required this.settings,
    required this.title,
    required this.body,
    this.actions,
    this.drawer,
    this.bottomNav,
    this.fab,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: appNavy,
        foregroundColor: Colors.white,
        title: Text(title),
        actions: [
          ...(actions ?? []),
          _LangMenu(settings: settings),
          _ThemeMenu(settings: settings),
        ],
      ),
      drawer: drawer,
      body: Column(
        children: [
          _TextSizeBar(settings: settings),
          Expanded(child: body),
        ],
      ),
      bottomNavigationBar: bottomNav,
      floatingActionButton: fab,
    );
  }
}

class _LangMenu extends StatelessWidget {
  final AppSettings settings;
  const _LangMenu({required this.settings});

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '🌐 Language',
      icon: Text(
        settings.lang == 'hi' ? '🌐 हिं' : '🌐 EN',
        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
      ),
      onSelected: (v) => settings.setLang(v),
      itemBuilder: (c) => [
        PopupMenuItem(
          value: 'en',
          child: Text('English ${settings.lang == 'en' ? '✓' : ''}'),
        ),
        PopupMenuItem(
          value: 'hi',
          child: Text('हिन्दी ${settings.lang == 'hi' ? '✓' : ''}'),
        ),
      ],
    );
  }
}

class _ThemeMenu extends StatelessWidget {
  final AppSettings settings;
  const _ThemeMenu({required this.settings});

  String get _icon {
    switch (settings.themeMode) {
      case 'light':
        return '☀';
      case 'dark':
        return '☾';
      default:
        return '◐';
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = settings.lang;
    return PopupMenuButton<String>(
      tooltip: t(lang, 'appearance'),
      icon: Text(_icon, style: const TextStyle(color: Colors.white, fontSize: 20)),
      onSelected: (v) => settings.setTheme(v),
      itemBuilder: (c) => [
        PopupMenuItem(value: 'light', child: Text('☀ ${t(lang, 'theme_light')}')),
        PopupMenuItem(value: 'dark', child: Text('☾ ${t(lang, 'theme_dark')}')),
        PopupMenuItem(value: 'system', child: Text('◐ ${t(lang, 'theme_system')}')),
      ],
    );
  }
}

class _TextSizeBar extends StatelessWidget {
  final AppSettings settings;
  const _TextSizeBar({required this.settings});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Row(
        children: [
          const Text('A', style: TextStyle(fontSize: 12)),
          IconButton(
            tooltip: 'A-',
            iconSize: 18,
            icon: const Text('A-'),
            onPressed: () => settings.bumpText(-2),
          ),
          IconButton(
            tooltip: 'A',
            iconSize: 18,
            icon: const Text('A'),
            onPressed: () => settings.resetText(),
          ),
          IconButton(
            tooltip: 'A+',
            iconSize: 18,
            icon: const Text('A+'),
            onPressed: () => settings.bumpText(2),
          ),
          const Spacer(),
          Text('${settings.textPx}px',
              style: const TextStyle(fontSize: 11, color: Colors.grey)),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../services/announcement_store.dart';

/// Top strip: maintenance block (non-dismissible, deepOrange) + active
/// announcements (severity color, per-id dismiss persisted). AppScaffold
/// body me _TextSizeBar ke turant neeche mount hota hai; khali ho to
/// SizedBox.shrink.
class AnnouncementBanner extends StatelessWidget {
  const AnnouncementBanner({super.key});

  Color _sevColor(String s) => switch (s) {
        'critical' => Colors.red,
        'maintenance' => Colors.deepOrange,
        'warning' => Colors.orange,
        _ => Colors.blue,
      };

  IconData _sevIcon(String s) => switch (s) {
        'critical' => Icons.error_outline,
        'maintenance' => Icons.build,
        'warning' => Icons.warning_amber,
        _ => Icons.info_outline,
      };

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: AnnouncementStore.instance,
      builder: (context, _) {
        final store = AnnouncementStore.instance;
        final visible = store.visibleItems();
        if (!store.maintenanceBlocked && visible.isEmpty) {
          return const SizedBox.shrink();
        }
        return Column(
          children: [
            if (store.maintenanceBlocked)
              _Strip(
                color: Colors.deepOrange,
                icon: Icons.build,
                title: 'Maintenance',
                body: store.maintenanceMessage,
                onDismiss: null,
              ),
            ...visible.map((a) {
              final sev = '${a['severity']}';
              return _Strip(
                color: _sevColor(sev),
                icon: _sevIcon(sev),
                title: '${a['title']}',
                body: '${a['body']}',
                onDismiss: () => store.dismiss('${a['id']}'),
              );
            }),
          ],
        );
      },
    );
  }
}

class _Strip extends StatelessWidget {
  final Color color;
  final IconData icon;
  final String title;
  final String body;
  final VoidCallback? onDismiss;

  const _Strip({
    required this.color,
    required this.icon,
    required this.title,
    required this.body,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: color.withValues(alpha: 0.12),
      padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, color: color),
                ),
                Text(
                  body,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12.5),
                ),
              ],
            ),
          ),
          if (onDismiss != null)
            IconButton(
              tooltip: 'Band karo',
              visualDensity: VisualDensity.compact,
              iconSize: 18,
              icon: const Icon(Icons.close),
              onPressed: onDismiss,
            ),
        ],
      ),
    );
  }
}

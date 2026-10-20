import 'api_client.dart';

/// Staff auth — /api/admin/login (admins table only, customer/driver
/// yahan kabhi login nahi hote) + superadmin read endpoints.
/// Role server response se aata hai; app koi role assume nahi karti.
///
/// Phase 4: full admin console coverage — mirrors
/// apnashift-backend/src/routes/admin.js + settlements.js (admin part)
/// + enterprise.js (admin part). Query/body shapes match zod schemas.
class AdminApi {
  final ApiClient api;
  AdminApi(this.api);

  Future<({String token, String role, String name})> login({
    required String phone,
    required String password,
  }) async {
    final d = await api.post('/api/admin/login', body: {'phone': phone, 'password': password});
    final u = d['user'] as Map<String, dynamic>;
    return (
      token: (d['token'] ?? '').toString(),
      role: (u['role'] ?? 'admin').toString(),
      name: (u['name'] ?? '').toString(),
    );
  }

  Future<Map<String, dynamic>> overview() async {
    final d = await api.get('/api/superadmin/overview');
    return Map<String, dynamic>.from(d);
  }

  Future<List<Map<String, dynamic>>> auditLogs(
      {int limit = 20,
      String? action,
      String? entity,
      int page = 1}) async {
    final d = await api.get('/api/superadmin/audit-logs', query: {
      'limit': '$limit',
      'page': '$page',
      if (action != null && action.isNotEmpty) 'action': action,
      if (entity != null && entity.isNotEmpty) 'entity': entity,
    });
    final rows = (d['logs'] ?? []) as List;
    return rows.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }

  Future<int> auditLogsTotal(
      {String? action, String? entity, int limit = 1}) async {
    final d = await api.get('/api/superadmin/audit-logs', query: {
      'limit': '$limit',
      'page': '1',
      if (action != null && action.isNotEmpty) 'action': action,
      if (entity != null && entity.isNotEmpty) 'entity': entity,
    });
    return int.tryParse('${d['total'] ?? 0}') ?? 0;
  }

  // ---- Overview ----

  Future<Map<String, dynamic>> stats() async {
    return api.get('/api/admin/stats');
  }

  // ---- Drivers ----

  Future<({List<Map<String, dynamic>> items, int total})> drivers(
      {String status = 'pending', int page = 1, int limit = 20}) async {
    final d = await api.get('/api/admin/drivers',
        query: {'status': status, 'page': '$page', 'limit': '$limit'});
    final raw = (d['drivers'] ?? []) as List;
    return (
      items: raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
      total: int.tryParse('${d['total'] ?? 0}') ?? 0,
    );
  }

  Future<void> verifyDriver(String id) async {
    await api.patch('/api/admin/drivers/$id/verify');
  }

  Future<void> rejectDriver(String id, String reason) async {
    await api.patch('/api/admin/drivers/$id/reject', body: {'reason': reason});
  }

  Future<void> deactivateDriver(String id) async {
    await api.patch('/api/admin/drivers/$id/deactivate');
  }

  Future<void> reactivateDriver(String id) async {
    await api.patch('/api/admin/drivers/$id/reactivate');
  }

  Future<Map<String, dynamic>> lookupAccount(String phone) async {
    return api.get('/api/admin/accounts/lookup', query: {'phone': phone});
  }

  Future<void> resetUserPassword(String id, String newPassword) async {
    await api.patch('/api/admin/users/$id/reset-password',
        body: {'new_password': newPassword});
  }

  Future<void> resetDriverPassword(String id, String newPassword) async {
    await api.patch('/api/admin/drivers/$id/reset-password',
        body: {'new_password': newPassword});
  }

  // ---- Bookings ----

  Future<({List<Map<String, dynamic>> items, int total})> bookings(
      {String? status,
      bool? disputed,
      String? from,
      String? to,
      int page = 1,
      int limit = 20}) async {
    final d = await api.get('/api/admin/bookings', query: {
      if (status != null && status.isNotEmpty) 'status': status,
      if (disputed != null) 'disputed': '$disputed',
      if (from != null && from.isNotEmpty) 'from': from,
      if (to != null && to.isNotEmpty) 'to': to,
      'page': '$page',
      'limit': '$limit',
    });
    final raw = (d['bookings'] ?? []) as List;
    return (
      items: raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
      total: int.tryParse('${d['total'] ?? 0}') ?? 0,
    );
  }

  Future<void> assignBooking(String bookingId, String driverId) async {
    await api.patch('/api/admin/bookings/$bookingId/assign',
        body: {'driver_id': driverId});
  }

  // ---- Pricing ----

  Future<List<Map<String, dynamic>>> pricingRules() async {
    final d = await api.get('/api/admin/pricing-rules');
    // Backend returns {ok, rules:[...]} (fallback: whole body scan).
    final raw = (d['rules'] ?? d['pricing_rules'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<void> updatePricing(
      {required String vehicleType,
      double? baseRs,
      double? perKmRs,
      double? helperRs,
      double? commissionPct}) async {
    await api.put('/api/admin/pricing-rules', body: {
      'vehicle_type': vehicleType,
      if (baseRs != null) 'base_rs': baseRs,
      if (perKmRs != null) 'per_km_rs': perKmRs,
      if (helperRs != null) 'helper_rs': helperRs,
      if (commissionPct != null) 'commission_pct': commissionPct,
    });
  }

  Future<List<Map<String, dynamic>>> pricingHistory({int limit = 20}) async {
    final d = await api.get('/api/admin/pricing-rules/history',
        query: {'limit': '$limit'});
    final raw = (d['history'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<Map<String, dynamic>> commission() async {
    return api.get('/api/admin/commission');
  }

  Future<void> updateCommission(double pct) async {
    await api.put('/api/admin/commission', body: {'pct': pct});
  }

  // ---- Tracking ----

  Future<Map<String, dynamic>> trackingActive({int limit = 50}) async {
    return api.get('/api/admin/tracking/active',
        query: {'limit': '$limit'});
  }

  // ---- Money ----

  Future<List<Map<String, dynamic>>> driverBalances({int limit = 50}) async {
    final d = await api
        .get('/api/admin/driver-balances', query: {'limit': '$limit'});
    final raw = (d['balances'] ?? d['drivers'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<Map<String, dynamic>> ledger({String? driverId}) async {
    return api.get('/api/admin/ledger', query: {
      if (driverId != null && driverId.isNotEmpty) 'driver_id': driverId,
    });
  }

  Future<Map<String, dynamic>> createSettlement(
      {required String driverId,
      required double amountRs,
      required String method,
      String? referenceNo,
      String? notes}) async {
    return api.post('/api/admin/settlements', body: {
      'driver_id': driverId,
      'amount_rs': amountRs,
      'method': method,
      if (referenceNo != null && referenceNo.isNotEmpty)
        'reference_no': referenceNo,
      if (notes != null && notes.isNotEmpty) 'notes': notes,
    });
  }

  Future<Map<String, dynamic>> reportsSummary(
      {String? from, String? to, String groupBy = 'day'}) async {
    return api.get('/api/admin/reports/summary', query: {
      if (from != null && from.isNotEmpty) 'from': from,
      if (to != null && to.isNotEmpty) 'to': to,
      'group_by': groupBy,
    });
  }

  Future<List<Map<String, dynamic>>> settlementPeriods(
      {String? status, int limit = 15}) async {
    final d = await api.get('/api/admin/settlement-periods', query: {
      if (status != null && status.isNotEmpty) 'status': status,
      'limit': '$limit',
    });
    final raw = (d['periods'] ?? d['settlement_periods'] ?? []) as List;
    return raw
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<Map<String, dynamic>> generatePeriod(
      {String? driverId, String? weekStart}) async {
    return api.post('/api/admin/settlement-periods/generate', body: {
      if (driverId != null && driverId.isNotEmpty) 'driver_id': driverId,
      if (weekStart != null && weekStart.isNotEmpty)
        'week_start': weekStart,
    });
  }

  Future<Map<String, dynamic>> payPeriod(String periodId,
      {required double amountRs,
      required String method,
      String? referenceNo,
      String? notes}) async {
    return api.post('/api/admin/settlement-periods/$periodId/payments',
        body: {
          'amount_rs': amountRs,
          'method': method,
          if (referenceNo != null && referenceNo.isNotEmpty)
            'reference_no': referenceNo,
          if (notes != null && notes.isNotEmpty) 'notes': notes,
        });
  }

  Future<void> disputePeriod(String periodId, [String? reason]) async {
    await api.patch('/api/admin/settlement-periods/$periodId/dispute',
        body: {if (reason != null && reason.isNotEmpty) 'reason': reason});
  }

  Future<void> resolvePeriod(String periodId) async {
    await api.patch('/api/admin/settlement-periods/$periodId/resolve');
  }

  // ---- Enterprise (admin side) ----

  Future<({List<Map<String, dynamic>> items, int total})> enterpriseInquiries(
      {String? status, String? search, int page = 1}) async {
    final d = await api.get('/api/enterprise/inquiries', query: {
      if (status != null && status.isNotEmpty) 'status': status,
      if (search != null && search.isNotEmpty) 'search': search,
      'page': '$page',
    });
    final raw = (d['inquiries'] ?? []) as List;
    return (
      items: raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
      total: int.tryParse('${d['total'] ?? 0}') ?? 0,
    );
  }

  Future<void> setInquiryStatus(String id, String status) async {
    await api.patch('/api/enterprise/inquiries/$id/status',
        body: {'status': status});
  }

  // ---- Super-admin: customer detail (SELECT-only router) ----

  Future<Map<String, dynamic>> superadminCustomer(String id) async {
    return api.get('/api/superadmin/customers/$id');
  }

  // ---- Announcements (super_admin: CRUD + push control) ----

  Future<
      ({
        List<Map<String, dynamic>> items,
        int total,
        bool fcmConfigured
      })> announcements(
      {String? status, String? audience, int page = 1, int limit = 20}) async {
    final d = await api.get('/api/announcements', query: {
      if (status != null && status.isNotEmpty) 'status': status,
      if (audience != null && audience.isNotEmpty) 'audience': audience,
      'page': '$page',
      'limit': '$limit',
    });
    final raw = (d['items'] ?? []) as List;
    return (
      items: raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
      total: int.tryParse('${d['total'] ?? 0}') ?? 0,
      fcmConfigured: d['fcm_configured'] == true,
    );
  }

  Future<Map<String, dynamic>> createAnnouncement(
      Map<String, dynamic> body) async {
    final d = await api.post('/api/announcements', body: body);
    return Map<String, dynamic>.from(d['announcement'] as Map? ?? d);
  }

  Future<Map<String, dynamic>> updateAnnouncement(
      String id, Map<String, dynamic> body) async {
    final d = await api.patch('/api/announcements/$id', body: body);
    return Map<String, dynamic>.from(d['announcement'] as Map? ?? d);
  }

  Future<Map<String, dynamic>> announcementPushReport(String id) async {
    return api.get('/api/announcements/$id/push');
  }

  Future<Map<String, dynamic>> runAnnouncementPush(String id) async {
    return api.post('/api/announcements/$id/push/run');
  }

  /// Public feed (banner source) — customer app bhi yahi use karti hai.
  Future<Map<String, dynamic>> activeAnnouncements({String? audience}) async {
    return api.get('/api/announcements/active', query: {
      if (audience != null && audience.isNotEmpty) 'audience': audience,
    });
  }

  // ---- App releases (super_admin: CRUD + push control) ----

  Future<
      ({
        List<Map<String, dynamic>> items,
        int total,
        bool fcmConfigured
      })> appReleases(
      {String? status, int page = 1, int limit = 20}) async {
    final d = await api.get('/api/app-updates', query: {
      if (status != null && status.isNotEmpty) 'status': status,
      'page': '$page',
      'limit': '$limit',
    });
    final raw = (d['items'] ?? []) as List;
    return (
      items: raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList(),
      total: int.tryParse('${d['total'] ?? 0}') ?? 0,
      fcmConfigured: d['fcm_configured'] == true,
    );
  }

  Future<Map<String, dynamic>> createAppRelease(
      Map<String, dynamic> body) async {
    final d = await api.post('/api/app-updates', body: body);
    return Map<String, dynamic>.from(d['release'] as Map? ?? d);
  }

  Future<Map<String, dynamic>> updateAppRelease(
      String id, Map<String, dynamic> body) async {
    final d = await api.patch('/api/app-updates/$id', body: body);
    return Map<String, dynamic>.from(d['release'] as Map? ?? d);
  }

  Future<Map<String, dynamic>> appReleasePushReport(String id) async {
    return api.get('/api/app-updates/$id/push');
  }

  Future<Map<String, dynamic>> runAppReleasePush(String id) async {
    return api.post('/api/app-updates/$id/push/run');
  }

  // ---- Payment adjustments (append-only corrections) ----

  Future<Map<String, dynamic>> createAdjustment(
      {required String paymentId,
      int commissionDeltaPaise = 0,
      int earningDeltaPaise = 0,
      required String reason}) async {
    return api.post('/api/admin/adjustments', body: {
      'payment_id': paymentId,
      'commission_delta_paise': commissionDeltaPaise,
      'earning_delta_paise': earningDeltaPaise,
      'reason': reason,
    });
  }

  Future<Map<String, dynamic>> paymentDetail(String paymentId) async {
    return api.get('/api/admin/payments/$paymentId');
  }
}

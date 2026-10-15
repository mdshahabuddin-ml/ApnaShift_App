import '../api/api_client.dart';

/// B2B lead — mirrors apnashift-backend/src/routes/enterprise.js.
/// POST is public (write-limited); list/status are admin (in AdminApi).
/// Enum lists mirror validation/enterprise.js exactly.
const enterpriseBusinessTypes = [
  'ecommerce',
  'retail',
  'manufacturing',
  'construction',
  'hospitality',
  'healthcare',
  'education',
  'corporate',
  'other',
];
const enterpriseCompanySizes = ['1-10', '11-50', '51-200', '201-500', '500+'];
const enterpriseServices = [
  'local_delivery',
  'business_transport',
  'goods_transport',
  'fleet_services',
  'employee_transport',
  'scheduled_deliveries',
  'on_demand_delivery',
  'intercity_transport',
  'other',
];
const enterpriseVehicles = [
  'bike',
  'auto',
  'mini_truck',
  'pickup',
  'lcv',
  'truck',
  'other',
];
const enterpriseFleetSizes = ['1-5', '6-20', '21-50', '51-100', '100+'];
const enterpriseMonthlyTrips = ['1-100', '101-500', '501-1000', '1000+'];
const enterpriseFrequencies = ['daily', 'weekly', 'monthly', 'on_demand'];
const enterpriseBudgets = [
  'under_25k',
  '25k_50k',
  '50k_1l',
  '1l_plus',
  'discuss'
];

class EnterpriseApi {
  final ApiClient _api;
  EnterpriseApi(this._api);

  /// Returns {id, status}. Throws ApiException(duplicate_inquiry) on 409.
  Future<Map<String, dynamic>> submit(Map<String, dynamic> fields) async {
    final d = await _api.post('/api/enterprise/inquiries', body: fields);
    return Map<String, dynamic>.from(d);
  }
}

/// Client-side validation mirroring inquiryCreateSchema + enterprise.html.
String? validateEnterprise(Map<String, dynamic> f) {
  String s(String k) => (f[k] ?? '').toString().trim();
  if (s('full_name').length < 2) return 'Full name kam se kam 2 akshar.';
  if (s('full_name').length > 100) {
    return 'Full name 100 akshar se zyada nahi.';
  }
  if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(s('email'))) {
    return 'Sahi work email likho.';
  }
  var p = s('phone').replaceAll(RegExp(r'[\s\-]'), '');
  if (p.startsWith('+91')) p = p.substring(3);
  if (p.startsWith('91') && p.length == 12) p = p.substring(2);
  if (p.startsWith('0') && p.length == 11) p = p.substring(1);
  if (!RegExp(r'^[6-9][0-9]{9}$').hasMatch(p)) {
    return 'Phone 10 digit Indian mobile (6-9 se shuru).';
  }
  if (s('company_name').length < 2) {
    return 'Company name kam se kam 2 akshar.';
  }
  if (s('website').isNotEmpty && !s('website').contains('.')) {
    return 'Sahi website URL likho (dot hona chahiye).';
  }
  final loc = int.tryParse(s('locations_count'));
  if (s('locations_count').isNotEmpty &&
      (loc == null || loc < 1 || loc > 100000)) {
    return 'Locations 1-100000 ke beech ho.';
  }
  if (s('requirements').length > 1000) {
    return 'Requirements 1000 akshar tak.';
  }
  if (f['consent'] != true) return 'Terms consent zaroori hai.';
  return null;
}

String normalizeEnterprisePhone(String v) {
  var p = v.replaceAll(RegExp(r'[\s\-]'), '');
  if (p.startsWith('+91')) p = p.substring(3);
  if (p.startsWith('91') && p.length == 12) p = p.substring(2);
  if (p.startsWith('0') && p.length == 11) p = p.substring(1);
  return p;
}

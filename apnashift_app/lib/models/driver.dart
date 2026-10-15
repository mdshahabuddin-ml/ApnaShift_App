/// Driver identity — mirrors POST /api/drivers/register response user +
/// GET /api/auth/me (role=driver). Never carries hash/phone secrets beyond
/// what backend already returns.
class DriverUser {
  final String id;
  final String name;
  final String phone;
  final String role;
  final String vehicleType;
  final String vehicleNumber;
  final bool isVerified;
  final String? upiId;
  final String? applicationRef;
  final String? email;
  final String? city;

  const DriverUser({
    required this.id,
    required this.name,
    required this.phone,
    this.role = 'driver',
    this.vehicleType = '',
    this.vehicleNumber = '',
    this.isVerified = false,
    this.upiId,
    this.applicationRef,
    this.email,
    this.city,
  });

  factory DriverUser.fromJson(Map<String, dynamic> j) => DriverUser(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        role: (j['role'] ?? 'driver').toString(),
        vehicleType: (j['vehicle_type'] ?? '').toString(),
        vehicleNumber: (j['vehicle_number'] ?? '').toString(),
        isVerified: j['is_verified'] == true,
        upiId: j['upi_id']?.toString(),
        applicationRef: j['application_ref']?.toString(),
        email: j['email']?.toString(),
        city: j['city']?.toString(),
      );

  bool get isDriver => role == 'driver';
}

/// Driver registration result — token + application status card.
class DriverApplication {
  final String ref;
  final String status;
  final String? registeredAt;

  const DriverApplication(
      {required this.ref, required this.status, this.registeredAt});

  factory DriverApplication.fromJson(Map<String, dynamic> j) =>
      DriverApplication(
        ref: (j['id'] ?? '').toString(),
        status: (j['status'] ?? 'PENDING_REVIEW').toString(),
        registeredAt: j['registered_at']?.toString(),
      );
}

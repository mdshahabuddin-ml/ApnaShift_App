/// Backend roles — /api/auth/* aur /api/driver/* inhi pe gate hote hain.
class AppRole {
  static const user = 'user';
  static const driver = 'driver';
  static const admin = 'admin';
  static const superAdmin = 'super_admin';
}

/// Logged-in identity (hash/phone kabhi nahi — backend bhi nahi bhejta).
class AppUser {
  final String id;
  final String name;
  final String phone;
  final String role;

  const AppUser({required this.id, required this.name, required this.phone, required this.role});

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        phone: (j['phone'] ?? '').toString(),
        role: (j['role'] ?? AppRole.user).toString(),
      );

  bool get isDriver => role == AppRole.driver;

  /// Ye app sirf customer (role=user) ke liye hai. Driver/admin token se
  /// login succeed ho jata hai (backend teeno table check karta hai), par
  /// /api/bookings requireRole('user') par 403 dega — isliye gate yahin.
  bool get isCustomer => role == AppRole.user;
}

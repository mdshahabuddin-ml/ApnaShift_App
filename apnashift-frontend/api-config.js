// API base URL - poori website ke liye EK hi jagah.
// Koi production URL hardcode nahi hota (Railway wind-down / AGENTS rule).
// localhost / 127.0.0.1 / file:// -> seedha local backend (port 3000).
// Baaki sab hosts (LAN IP, Cloudflare tunnel, future prod) -> "" = SAME-ORIGIN:
// page jis origin par serve ho, /api/requests bhi usi origin par jayenge
// (Express backend public/ se hi pages serve karta hai).
window.API_BASE_URL = (window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.protocol === "file:")
  ? "http://localhost:3000"
  : "";
